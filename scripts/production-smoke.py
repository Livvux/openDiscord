"""Read-only release proof: checkout, immutable running image, migrations and public HTTP contracts."""
import argparse
import hashlib
import http.client
import json
import re
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path


class SmokeFailure(Exception):
    pass


def command(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=15).stdout.strip()


def verify_revision(root: Path, expected: str, web: str, database: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", expected):
        raise SmokeFailure("invalid-release-sha")
    if not all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name) for name in (web, database)):
        raise SmokeFailure("invalid-container-selector")
    if command("git", "-C", str(root), "rev-parse", "HEAD") != expected:
        raise SmokeFailure("checkout-revision-mismatch")
    if command("git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"):
        raise SmokeFailure("checkout-not-clean")
    if command("docker", "inspect", web, "--format", "{{.State.Running}}") != "true":
        raise SmokeFailure("web-container-not-running")
    image = command("docker", "inspect", web, "--format", "{{.Image}}")
    revision = command("docker", "image", "inspect", image, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}')
    if revision != expected:
        raise SmokeFailure("running-image-revision-unverified")
    migrations = root / "apps/web/drizzle"
    entries = json.loads((migrations / "meta/_journal.json").read_text())["entries"]
    hashes = [hashlib.sha256((migrations / (entry["tag"] + ".sql")).read_bytes()).hexdigest() for entry in entries]
    applied = command("docker", "exec", database, "sh", "-c",
                      'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select hash from drizzle.__drizzle_migrations order by created_at"').splitlines()
    if not hashes or applied != hashes:
        raise SmokeFailure("migration-journal-mismatch")
    return image


def fetch(origin: str, path: str, limit: int = 32768) -> tuple[bytes, dict[str, str]]:
    target = origin + path
    request = urllib.request.Request(target, headers={"User-Agent": "openDiscord-release-smoke/1"})
    with urllib.request.urlopen(request, timeout=8) as response:
        body = response.read(limit + 1)
        if response.status != 200 or response.geturl() != target or len(body) > limit:
            raise SmokeFailure("unexpected-http-response")
        for name in ("Strict-Transport-Security", "Content-Security-Policy", "X-Content-Type-Options"):
            if len(response.headers.get_all(name, [])) > 1:
                raise SmokeFailure("ambiguous-security-headers")
        return body, {name.lower(): value for name, value in response.headers.items()}


def verify_http(origin: str) -> dict:
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")
            or not parsed.hostname or parsed.scheme not in ("https", "http")
            or (parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1"))):
        raise SmokeFailure("invalid-origin")
    origin = origin.rstrip("/")
    for path, status in (("/api/health", "ok"), ("/api/ready", "ready")):
        body, headers = fetch(origin, path, 4096)
        if (json.loads(body) != {"status": status} or "no-store" not in headers.get("cache-control", "")
                or "application/json" not in headers.get("content-type", "")):
            raise SmokeFailure("health-contract-failed")
    body, headers = fetch(origin, "/manifest.webmanifest")
    manifest = json.loads(body)
    if ("application/manifest+json" not in headers.get("content-type", "") or not isinstance(manifest, dict)
            or manifest.get("name") != "openDiscord" or manifest.get("start_url") != "/app"
            or manifest.get("display") != "standalone" or not isinstance(manifest.get("icons"), list) or not manifest["icons"]):
        raise SmokeFailure("manifest-contract-failed")
    for icon in manifest["icons"]:
        if not isinstance(icon, dict):
            raise SmokeFailure("invalid-icon-entry")
        path = icon.get("src", "")
        if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or "\\" in path:
            raise SmokeFailure("invalid-icon-path")
        content, icon_headers = fetch(origin, path, 2 * 1024 * 1024)
        if not content.startswith(b"\x89PNG\r\n\x1a\n") or icon_headers.get("content-type") != "image/png":
            raise SmokeFailure("icon-contract-failed")
    _, headers = fetch(origin, "/sign-in", 1024 * 1024)
    csp = headers.get("content-security-policy", "")
    directives = {}
    for directive in csp.split(";"):
        parts = directive.split()
        if parts:
            # Browsers ignore later occurrences of the same directive.
            directives.setdefault(parts[0].lower(), parts[1:])
    hsts_ages = [part.strip() for part in headers.get("strict-transport-security", "").split(";")
                 if part.strip().lower().split("=", 1)[0].strip() == "max-age"]
    hsts_valid = len(hsts_ages) == 1 and re.fullmatch(r"max-age\s*=\s*[0-9]+", hsts_ages[0], re.IGNORECASE)
    hsts_valid = bool(hsts_valid and int(hsts_ages[0].split("=", 1)[1]) > 0)
    if ("," in csp or directives.get("script-src-attr") != ["'none'"] or directives.get("frame-ancestors") != ["'none'"]
            or headers.get("x-content-type-options") != "nosniff"
            or (parsed.scheme == "https" and not hsts_valid)):
        raise SmokeFailure("security-header-contract-failed")
    return {"health": "PASS", "ready": "PASS", "manifest": "PASS", "icons": len(manifest["icons"]), "headers": "PASS"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--web-container", required=True)
    parser.add_argument("--database-container", required=True)
    parser.add_argument("--origin", default="https://opendiscord.app")
    args = parser.parse_args()
    image = verify_revision(Path(__file__).resolve().parent.parent, args.expected_sha, args.web_container, args.database_container)
    checks = verify_http(args.origin)
    print(json.dumps({"status": "PASS", "revision": args.expected_sha, "image": image, "checks": checks}))


if __name__ == "__main__":
    try:
        main()
    except SmokeFailure as error:
        print(json.dumps({"status": "FAIL", "reason": str(error)}))
        raise SystemExit(1) from None
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException, subprocess.SubprocessError):
        # Third-party errors can contain connection details; only stable outcome codes leave this boundary.
        print(json.dumps({"status": "FAIL", "reason": "probe-unavailable-or-invalid"}))
        raise SystemExit(1) from None
