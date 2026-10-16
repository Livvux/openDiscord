"""Bounded cleanup and incomplete-download regressions; no app/runtime launch."""
import io
import json
import pathlib
import signal
import subprocess
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch

import native_app_flows as flows


class NativeSupportTests(unittest.TestCase):
    def test_hung_drivers_all_receive_signal_before_wait_and_share_budget(self):
        events = []
        clock = [0.0]

        def process(pid):
            def wait(timeout):
                events.append(('wait', pid))
                clock[0] += timeout
                raise subprocess.TimeoutExpired('owned fake process', timeout)
            return types.SimpleNamespace(pid=pid, wait=wait)

        clients = [types.SimpleNamespace(process=process(pid), log=io.StringIO())
                   for pid in [12001, 12002, 12003]]
        with patch.object(flows.os, 'killpg', side_effect=lambda pid, sig: events.append((sig, pid))), \
                patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]):
            errors = flows.cleanup_clients(clients, budget=10)
        self.assertEqual(events[:3], [(signal.SIGTERM, pid) for pid in [12001, 12002, 12003]])
        self.assertEqual([pid for sig, pid in events if sig == signal.SIGKILL], [12001, 12002, 12003])
        self.assertLessEqual(clock[0], 10)
        self.assertEqual(errors, ['ProcessReapDeadline'] * 3)
        self.assertTrue(all(client.log.closed for client in clients))

    def test_partial_or_wrong_schema_json_is_not_complete_recovery(self):
        value = {'format': 'opendiscord.e2ee-recovery', 'version': 2,
                 'origin': flows.ORIGIN, 'userId': 'disposable-user',
                 'backupId': '550e8400-e29b-41d4-a716-446655440000', 'encryptionInfo': 'disposable'}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'recovery.json'
            path.write_text('{"format":')

            def wait_after_writes(check):
                self.assertIsNone(check())
                path.write_text('{"format":"wrong"}')
                self.assertIsNone(check())
                path.write_text(json.dumps(value))
                return check()

            with patch.object(flows, 'wait', side_effect=wait_after_writes):
                self.assertEqual(flows.complete_json(path, flows.recovery_shape), value)

    def test_console_only_explicit_w3c_unsupported_codes_are_unavailable(self):
        for code, expected in [('unknown command', True), ('unsupported operation', True),
                               ('unknown error', False), ('invalid session id', False)]:
            with self.subTest(code=code):
                body = io.BytesIO(json.dumps({'value': {'error': code, 'message': 'not retained'}}).encode())
                error = urllib.error.HTTPError('http://127.0.0.1/log', 500, 'driver error', {}, body)
                self.assertEqual(flows.unsupported_command(error), expected)
        error = urllib.error.HTTPError('http://127.0.0.1/log', 500, 'driver error', {}, io.BytesIO(b'not-json'))
        self.assertFalse(flows.unsupported_command(error))


if __name__ == '__main__':
    unittest.main()
