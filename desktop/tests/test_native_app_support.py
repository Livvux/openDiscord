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

    def test_endpoint_diagnostics_never_retain_session_or_element_identifiers(self):
        self.assertEqual(flows.endpoint_class('/session/private-session/url'), 'navigation')
        self.assertEqual(flows.endpoint_class('/session/private-session/element/private-element/value'), 'element_input')
        self.assertEqual(flows.endpoint_class('/session/private-session/execute/sync'), 'sync_script')
        self.assertEqual(flows.endpoint_class('/unrecognized/private-value'), 'other')

    def test_transport_diagnostics_probe_once_and_emit_only_signature_counts(self):
        calls = []
        clock = [0.0]

        class Opener:
            def open(self, url, timeout):
                calls.append(url)
                clock[0] += timeout
                raise TimeoutError('private diagnostic text must never be retained')

        with tempfile.TemporaryFile() as log:
            log.write(b'private payload\nError serving connection: private session\n')
            log.flush()
            clients = [types.SimpleNamespace(profile=index, port=4444 + index * 2,
                       process=types.SimpleNamespace(poll=lambda: None), log=log) for index in range(3)]
            with patch.object(flows.urllib.request, 'build_opener', return_value=Opener()), \
                    patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(flows.pathlib.Path, 'read_text', return_value='MemAvailable: 123 kB\nMemTotal: 456 kB\n'):
                summary = flows.transport_diagnostics(clients)
        self.assertEqual(len(calls), 7)
        self.assertEqual(len(set(calls)), 7)
        self.assertLessEqual(clock[0], 10)
        self.assertEqual([profile['driver_signatures']['connection_error'] for profile in summary['profiles']], [1, 1, 1])
        self.assertNotIn('private', json.dumps(summary))
        self.assertNotIn('http', json.dumps(summary))
        self.assertEqual(summary['memory_kib']['MemAvailable'], 123)

    def test_nested_hyper_categories_are_allowlisted_without_log_payload(self):
        data = (b'Error serving connection: hyper::Error(User(Service), '
                b'hyper_util::client::legacy::Error(SendRequest, hyper::Error(IncompleteMessage))) private payload\n'
                b'Error serving connection: hyper::Error(PrivateSecret, private payload)\n')
        value = flows.driver_error_categories(data)
        self.assertEqual(value['legacy']['SendRequest'], 1)
        self.assertEqual(value['hyper']['User'], 1)
        self.assertEqual(value['hyper']['IncompleteMessage'], 1)
        self.assertNotIn('private', json.dumps(value).lower())
        self.assertEqual(sum(value['legacy'].values()) + sum(value['hyper'].values()), 3)

    def test_anyhow_display_chain_exposes_only_fixed_user_and_cause_categories(self):
        data = (b'Error serving connection: hyper::Error(User(Service), client error (SendRequest)\n'
                b'\nCaused by:\n    operation was canceled)\n'
                b'private unrelated log line\n')
        value = flows.driver_error_categories(data)
        self.assertEqual(value['hyper_user']['Service'], 1)
        self.assertEqual(value['legacy_display']['SendRequest'], 1)
        self.assertEqual(value['hyper_cause']['canceled'], 1)
        self.assertNotIn('private', json.dumps(value).lower())
        self.assertNotIn('client error', json.dumps(value))

    def test_preauth_contract_stops_failed_variant_without_retry_and_redacts_identifiers(self):
        calls = []
        timers = []

        def response(number):
            values = [{'ready': True}, [{flows.ELEMENT: 'private-element'}], True, True, True]
            result = io.BytesIO(json.dumps({'value': values[number]}).encode())
            result.status = 200
            return result

        def urlopen(request, timeout):
            self.assertLessEqual(timeout, 1)
            calls.append(request.full_url)
            if len(calls) == 1:
                raise flows.http.client.RemoteDisconnected('private transport text')
            return response(len(calls) - 2)

        class Connection:
            def __init__(self, host, port, timeout):
                self.number = 0
                self.timeout = timeout

            def request(self, method, path, body, headers):
                pass

            def getresponse(self):
                result = response(self.number)
                self.number += 1
                return result

            def close(self):
                pass

        clients = [types.SimpleNamespace(profile=index, port=4444 + index * 2,
                   session='private-session') for index in range(3)]
        with patch.object(flows.urllib.request, 'urlopen', side_effect=urlopen), \
                patch.object(flows.http.client, 'HTTPConnection', Connection), \
                patch.object(flows.signal, 'getitimer', return_value=(500, 0)), \
                patch.object(flows.signal, 'setitimer', side_effect=lambda *args: timers.append(args)), \
                patch.object(flows.signal, 'signal'), \
                patch.object(flows.time, 'monotonic', return_value=0):
            summary = flows.transport_contract(clients[0])
        self.assertEqual(len(calls), 6)
        self.assertEqual(summary['variants']['urllib_tauri']['status'], 'failed')
        self.assertEqual(len(summary['variants']['urllib_tauri']['commands']), 1)
        self.assertEqual(summary['variants']['urllib_native']['status'], 'passed')
        self.assertEqual(summary['variants']['persistent_tauri']['status'], 'passed')
        self.assertNotIn('private', json.dumps(summary).lower())
        self.assertNotIn('http://', json.dumps(summary))
        self.assertEqual(timers[0][1], 20)
        self.assertEqual(timers[-1][1], 500)

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
