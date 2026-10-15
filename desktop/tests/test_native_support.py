import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import Mock

from native_support import cleanup, has_complete_bytes


class NativeSupportTests(unittest.TestCase):
    def test_waits_for_complete_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'download'
            self.assertFalse(has_complete_bytes(path, b'complete'))
            path.write_bytes(b'com')
            self.assertFalse(has_complete_bytes(path, b'complete'))
            path.write_bytes(b'complete')
            self.assertTrue(has_complete_bytes(path, b'complete'))

    def test_cleanup_preserves_primary_and_runs_after_delete_failure(self):
        delete = Mock(side_effect=RuntimeError('session already gone'))
        driver, server, log = Mock(), Mock(), Mock()
        driver.wait.side_effect = [subprocess.TimeoutExpired('driver', 5), None]
        primary = AssertionError('original failure')
        remove_sandbox = Mock(side_effect=RuntimeError('sandbox busy'))
        cleanup(delete, driver, server, log, primary, remove_sandbox)
        driver.terminate.assert_called_once()
        driver.kill.assert_called_once()
        self.assertEqual(driver.wait.call_count, 2)
        server.shutdown.assert_called_once()
        server.server_close.assert_called_once()
        log.close.assert_called_once()
        remove_sandbox.assert_called_once()
        self.assertIn('session already gone', primary.__notes__[0])
        self.assertIn('sandbox busy', primary.__notes__[0])

    def test_cleanup_failure_without_primary_fails_acceptance(self):
        driver, server, log = Mock(), Mock(), Mock()
        server.shutdown.side_effect = RuntimeError('shutdown failed')
        with self.assertRaises(ExceptionGroup):
            cleanup(Mock(), driver, server, log, None)
        server.server_close.assert_called_once()
        log.close.assert_called_once()
