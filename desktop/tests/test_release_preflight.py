import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

DESKTOP = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP))
import release_preflight  # noqa: E402

APPLE = {name: 'x' for name in release_preflight.APPLE_CERT + release_preflight.APPLE_NOTARY}
WINDOWS = {name: 'x' for name in release_preflight.WINDOWS}


def tauri_cli_available():
    try:
        return subprocess.run(['cargo', 'tauri', '--version'], capture_output=True).returncode == 0
    except FileNotFoundError:
        return False


def generate_keypair(directory, password):
    """A throwaway keypair; never committed. Returns (private key, public key) as Tauri stores them."""
    pathlib.Path(directory).mkdir(parents=True, exist_ok=True)
    path = pathlib.Path(directory) / 'updater.key'
    subprocess.run(['cargo', 'tauri', 'signer', 'generate', '--ci', '-p', password, '-w', str(path)],
                   check=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=120)
    return path.read_text(), path.with_suffix('.key.pub').read_text()


def config(pubkey='', artifacts=False):
    return {'bundle': {'createUpdaterArtifacts': artifacts}, 'plugins': {'updater': {'pubkey': pubkey}}}


class ConfigurationTests(unittest.TestCase):
    def test_repository_config_is_consistent_without_secrets(self):
        committed = json.loads((DESKTOP / 'tauri.conf.json').read_text())
        errors, _, _ = release_preflight.check(committed, {}, allow_missing_updater_key=True)
        self.assertEqual(errors, [])

    def test_unsigned_preview_is_allowed_and_labelled(self):
        self.assertEqual(release_preflight.check(config(), {}), ([], [], ['updater', 'macOS', 'Windows']))

    def test_fully_signed_release_has_no_unsigned_parts(self):
        identity = {'APPLE_SIGNING_IDENTITY': 'Developer ID Application: Example (ABCDE12345)',
                    'APPLE_TEAM_ID': 'ABCDE12345'}
        errors, _, unsigned = release_preflight.check(config(), {**APPLE, **identity, **WINDOWS})
        self.assertEqual((errors, unsigned), ([], ['updater']))

    def test_placeholder_pubkey_fails(self):
        for placeholder in ('REPLACE_ME', base64.b64encode(b'untrusted comment: x\nnot a key').decode()):
            with self.subTest(placeholder=placeholder):
                errors, _, _ = release_preflight.check(config(placeholder), {}, allow_missing_updater_key=True)
                self.assertIn('pubkey', errors[0])

    def test_updater_artifacts_without_pubkey_fail(self):
        errors, _, _ = release_preflight.check(config(artifacts=True), {})
        self.assertIn('createUpdaterArtifacts', errors[0])

    def test_private_key_without_pubkey_fails(self):
        errors, _, _ = release_preflight.check(config(), {'TAURI_SIGNING_PRIVATE_KEY': 'x'})
        self.assertIn('pubkey in desktop/tauri.conf.json is empty', errors[0])

    def test_partial_macos_signing_fails(self):
        for missing in release_preflight.APPLE_NOTARY + ('APPLE_CERTIFICATE',):
            with self.subTest(missing=missing):
                env = {name: value for name, value in APPLE.items() if name != missing}
                errors, _, _ = release_preflight.check(config(), env)
                self.assertTrue(any(missing in error for error in errors), errors)

    def test_team_id_mismatch_fails(self):
        env = {**APPLE, 'APPLE_SIGNING_IDENTITY': 'Developer ID Application: Example (ABCDE12345)', 'APPLE_TEAM_ID': 'ZZZZZ99999'}
        errors, _, _ = release_preflight.check(config(), env)
        self.assertIn('APPLE_TEAM_ID', errors[0])

    def test_partial_windows_signing_fails(self):
        errors, _, _ = release_preflight.check(config(), {'WINDOWS_CERTIFICATE': 'x'})
        self.assertIn('WINDOWS_CERTIFICATE_PASSWORD', errors[0])

    def test_main_reports_unsigned_preview_to_github_output(self):
        with tempfile.TemporaryDirectory() as directory:
            conf = pathlib.Path(directory) / 'tauri.conf.json'
            output = pathlib.Path(directory) / 'output'
            conf.write_text(json.dumps(config()))
            with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}, clear=True):
                self.assertEqual(release_preflight.main(['--config', str(conf)]), 0)
            self.assertEqual(output.read_text(), 'signed=false\nunsigned=updater,macOS,Windows\n')
            conf.write_text(json.dumps(config(artifacts=True)))
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(release_preflight.main(['--config', str(conf)]), 1)


@unittest.skipUnless(tauri_cli_available() or os.environ.get('CI'), 'Tauri CLI (cargo tauri) is not installed')
class UpdaterKeyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.private, cls.public = generate_keypair(cls.directory.name, 'test-password')
        cls.other_private, cls.other_public = generate_keypair(cls.directory.name + '/other', 'test-password')

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def env(self, private, password='test-password'):
        return {'TAURI_SIGNING_PRIVATE_KEY': private, 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD': password}

    def test_matching_keypair_passes(self):
        errors, _, unsigned = release_preflight.check(config(self.public, artifacts=True), self.env(self.private))
        self.assertEqual(errors, [])
        self.assertNotIn('updater', unsigned)

    def test_mismatched_keypair_fails(self):
        errors, _, _ = release_preflight.check(config(self.public), self.env(self.other_private))
        self.assertIn('does not match plugins.updater.pubkey', errors[0])

    def test_wrong_or_missing_password_fails(self):
        for password in ('wrong', ''):
            with self.subTest(password=password):
                errors, _, _ = release_preflight.check(config(self.public), self.env(self.private, password))
                self.assertIn('PASSWORD is missing or wrong', errors[0])

    def test_pubkey_without_private_key_fails_for_releases_only(self):
        errors, warnings, _ = release_preflight.check(config(self.public), {})
        self.assertIn('TAURI_SIGNING_PRIVATE_KEY secret is missing', errors[0])
        errors, warnings, _ = release_preflight.check(config(self.public), {}, allow_missing_updater_key=True)
        self.assertEqual(errors, [])
        self.assertEqual(len(warnings), 1)


if __name__ == '__main__':
    unittest.main()
