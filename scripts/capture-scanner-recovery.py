"""Capture private scanner recovery configuration; definitions are regenerated, never archived."""
import json
import os
import shutil
import sys
from pathlib import Path


INSTALLED = (
    Path("/etc/systemd/system/opendiscord-scanner-monitor.service"),
    Path("/etc/systemd/system/opendiscord-scanner-monitor.timer"),
    Path("/etc/opendiscord-monitor/scanner.json"),
    Path("/usr/local/sbin/opendiscord-operator-monitor"),
)


def capture(work: Path, compose_dir: str | None) -> None:
    env = dict(item.split("=", 1) for item in json.loads((work / "web-env.json").read_text()) if "=" in item)
    configured = bool(env.get("CLAMAV_HOST"))
    if not compose_dir:
        if configured:
            raise ValueError("Configured scanner requires OPENDISCORD_SCANNER_COMPOSE_DIR")
        return
    source = Path(compose_dir)
    if not source.is_absolute():
        raise ValueError("Scanner Compose directory must be absolute")
    required = (source / "compose.yml", source / ".env")
    if not all(path.is_file() and path.stat().st_size for path in required):
        raise ValueError("Scanner recovery configuration is incomplete")
    target = work / "config" / "scanner"
    target.mkdir()
    (target / "app-scanner.json").write_text(json.dumps({
        "CLAMAV_HOST": env.get("CLAMAV_HOST", ""), "CLAMAV_PORT": env.get("CLAMAV_PORT", "3310")}))
    for path in required:
        shutil.copyfile(path, target / path.name)
    for path in INSTALLED:
        if path.is_file():
            destination = target / "installed" / path.relative_to("/")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
    (target / "restore.txt").write_text(
        "Definitions deliberately excluded; regenerate and verify loaded freshness before restoring scanning availability.\n"
        "App CLAMAV_HOST/PORT are captured separately in app.env; do not silently unset them on recovery.\n"
        "Installed monitor files are captured when present; absence is not monitoring acceptance.\n")


if __name__ == "__main__":
    try:
        capture(Path(sys.argv[1]), os.environ.get("OPENDISCORD_SCANNER_COMPOSE_DIR"))
    except (OSError, ValueError, KeyError, TypeError):
        raise SystemExit("Scanner recovery configuration capture failed; check private deployment paths") from None
