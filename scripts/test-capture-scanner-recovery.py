"""Exercise the production capture function with disposable files; no Docker/secrets."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("capture", Path(__file__).with_name("capture-scanner-recovery.py"))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CaptureTests(unittest.TestCase):
    def test_guarded_capture_and_restore_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work = root / "work"
            work.mkdir()
            (work / "config").mkdir()
            snapshot = work / "web-env.json"
            snapshot.write_text(json.dumps(["CLAMAV_HOST="]))
            capture.capture(work, None)
            self.assertFalse((work / "config/scanner").exists())
            snapshot.write_text(json.dumps(["CLAMAV_HOST=opendiscord-private-scanner"]))
            with self.assertRaises(ValueError):
                capture.capture(work, None)
            source = root / "scanner"
            source.mkdir()
            with self.assertRaises(ValueError):
                capture.capture(work, str(source))
            (source / "compose.yml").write_text("pinned scanner fixture")
            with self.assertRaises(ValueError):
                capture.capture(work, str(source))
            (source / ".env").write_text("OPENDISCORD_APP_PRIVATE_NETWORK=fixture-private\n")
            (source / "daily.cvd").write_text("definitions must not be captured")
            installed = root / "scanner.json"
            installed.write_text('{"mode":"scanner","smtp_url":"fixture"}')
            with patch.object(capture, "INSTALLED", (installed, root / "absent.timer")):
                capture.capture(work, str(source))
            archive = work / "config/scanner"
            self.assertEqual((archive / "compose.yml").read_text(), "pinned scanner fixture")
            self.assertEqual((archive / ".env").read_text(), (source / ".env").read_text())
            restored = archive / "installed" / installed.relative_to("/")
            self.assertEqual(restored.read_text(), installed.read_text())
            self.assertFalse(list(archive.rglob("*.cvd")))
            self.assertIn("regenerate", (archive / "restore.txt").read_text())
            self.assertIn("do not silently unset", (archive / "restore.txt").read_text())


if __name__ == "__main__":
    unittest.main()
