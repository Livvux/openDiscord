"""Release gates must reject old images, divergent migrations and HTML masquerading as a manifest."""
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("smoke", Path(__file__).with_name("production-smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class ReleaseSmokeTests(unittest.TestCase):
    sha = "a" * 40

    def test_image_and_ordered_migration_hashes_must_match_the_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            migrations = root / "apps/web/drizzle"
            (migrations / "meta").mkdir(parents=True)
            (migrations / "meta/_journal.json").write_text(json.dumps({"entries": [{"tag": "0000_test"}]}))
            (migrations / "0000_test.sql").write_text("select 1;\n")
            digest = hashlib.sha256(b"select 1;\n").hexdigest()
            with patch.object(smoke, "command", side_effect=[self.sha, "", "true", "sha256:image", self.sha, digest]):
                self.assertEqual(smoke.verify_revision(root, self.sha, "web-1", "db-1"), "sha256:image")
            cases = [(["b" * 40], "checkout-revision-mismatch"),
                     ([self.sha, " M Dockerfile"], "checkout-not-clean"),
                     ([self.sha, "", "false"], "web-container-not-running"),
                     ([self.sha, "", "true", "sha256:image", "unverified"], "running-image-revision-unverified"),
                     ([self.sha, "", "true", "sha256:image", self.sha, "wrong"], "migration-journal-mismatch")]
            for outputs, reason in cases:
                with patch.object(smoke, "command", side_effect=outputs), self.assertRaisesRegex(smoke.SmokeFailure, reason):
                    smoke.verify_revision(root, self.sha, "web-1", "db-1")

    def responses(self, manifest_type="application/manifest+json", csp="script-src-attr 'none'; frame-ancestors 'none'", hsts="max-age=31536000"):
        manifest = {"name": "openDiscord", "start_url": "/app", "display": "standalone", "icons": [{"src": "/icon.png"}]}
        return {
            "/api/health": (b'{"status":"ok"}', {"content-type": "application/json", "cache-control": "no-store"}),
            "/api/ready": (b'{"status":"ready"}', {"content-type": "application/json", "cache-control": "no-store"}),
            "/manifest.webmanifest": (json.dumps(manifest).encode(), {"content-type": manifest_type}),
            "/icon.png": (b"\x89PNG\r\n\x1a\n", {"content-type": "image/png"}),
            "/sign-in": (b"<html></html>", {"content-security-policy": csp, "x-content-type-options": "nosniff", "strict-transport-security": hsts}),
        }

    def test_http_contracts_include_manifest_mime_and_csp(self):
        with patch.object(smoke, "fetch", side_effect=lambda _origin, path, *_: self.responses()[path]):
            self.assertEqual(smoke.verify_http("https://example.test")["manifest"], "PASS")
        for responses, reason in ((self.responses(manifest_type="text/html"), "manifest-contract-failed"),
                                  (self.responses(csp="default-src 'self'"), "security-header-contract-failed")):
            with patch.object(smoke, "fetch", side_effect=lambda _origin, path, *_, data=responses: data[path]), self.assertRaisesRegex(smoke.SmokeFailure, reason):
                smoke.verify_http("https://example.test")

    def test_permissive_first_csp_directives_and_disabled_hsts_fail(self):
        cases = [self.responses(csp="script-src-attr *; frame-ancestors *; script-src-attr 'none'; frame-ancestors 'none'"),
                 self.responses(hsts="max-age=0"), self.responses(hsts="max-age=31536000; max-age=0"),
                 self.responses(hsts="includeSubDomains"), self.responses(hsts="max-age=invalid")]
        for responses in cases:
            with patch.object(smoke, "fetch", side_effect=lambda _origin, path, *_, data=responses: data[path]), \
                    self.assertRaisesRegex(smoke.SmokeFailure, "security-header-contract-failed"):
                smoke.verify_http("https://example.test")

    def test_invalid_origins_and_selectors_are_rejected_before_network_or_docker(self):
        with patch.object(smoke, "fetch") as fetch, patch.object(smoke, "command") as command:
            for origin in ("http://example.test", "https://user:password@example.test", "https://example.test/private", "https://example.test?token=private"):
                with self.assertRaises(smoke.SmokeFailure):
                    smoke.verify_http(origin)
            for sha, web in (("unverified", "web"), (self.sha, "--host=other")):
                with self.assertRaises(smoke.SmokeFailure):
                    smoke.verify_revision(Path("."), sha, web, "db")
            fetch.assert_not_called()
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
