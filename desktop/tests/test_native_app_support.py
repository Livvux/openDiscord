"""Bounded cleanup and incomplete-download regressions; no app/runtime launch."""
import io
import http.server
import socket
import threading
import json
import pathlib
import signal
import subprocess
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch
from contextlib import contextmanager

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

        clients = [types.SimpleNamespace(process=process(pid), log=io.StringIO(),
                   connection=types.SimpleNamespace(close=lambda pid=pid: events.append(('close', pid))))
                   for pid in [12001, 12002, 12003]]
        with patch.object(flows.os, 'killpg', side_effect=lambda pid, sig: events.append((sig, pid))), \
                patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]):
            errors = flows.cleanup_clients(clients, budget=10)
        self.assertEqual(events[:3], [(signal.SIGTERM, pid) for pid in [12001, 12002, 12003]])
        self.assertEqual([pid for sig, pid in events if sig == signal.SIGKILL], [12001, 12002, 12003])
        self.assertLessEqual(clock[0], 10)
        self.assertEqual(errors, ['ProcessReapDeadline'] * 3)
        self.assertTrue(all(client.log.closed for client in clients))
        self.assertEqual([pid for action, pid in events if action == 'close'], [12001, 12002, 12003])

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

    def test_matrix_identical_w3c_envelopes_and_first_error_stop(self):
        for fail_first in [False, True]:
            with self.subTest(fail_first=fail_first):
                calls = []
                timers = []
                clock = [0.0]
                positions = {4444: 0, 4445: 0}

                def response(number):
                    values = [{'ready': True}, [{flows.ELEMENT: 'private-element'}], True, True, True]
                    result = io.BytesIO(json.dumps({'value': values[number]}).encode())
                    result.status = 200
                    return result

                def urlopen(request, timeout):
                    self.assertLessEqual(timeout, 1)
                    calls.append(request.full_url)
                    clock[0] += .25
                    if fail_first and len(calls) == 1:
                        raise flows.http.client.RemoteDisconnected('private transport text')
                    port = flows.urllib.parse.urlsplit(request.full_url).port
                    result = response(positions[port])
                    positions[port] += 1
                    return result

                class Connection:
                    def __init__(self, host, port, timeout):
                        self.number = 0
                        self.timeout = timeout
                        self.sock = None

                    def request(self, method, path, body, headers):
                        pass

                    def getresponse(self):
                        result = response(self.number)
                        self.number += 1
                        return result

                    def close(self):
                        pass

                client = types.SimpleNamespace(profile=0, port=4444, session='private-session')
                with patch.object(flows.urllib.request, 'urlopen', side_effect=urlopen), \
                        patch.object(flows.http.client, 'HTTPConnection', Connection), \
                        patch.object(flows.signal, 'getitimer', return_value=(500, 0)), \
                        patch.object(flows.signal, 'setitimer', side_effect=lambda *args: timers.append(args)), \
                        patch.object(flows.signal, 'signal'), \
                        patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]):
                    summary = flows.transport_contract(client)
                self.assertEqual(len(calls), 6 if fail_first else 10)
                self.assertEqual(summary['variants']['urllib_tauri']['status'], 'failed' if fail_first else 'passed')
                self.assertEqual(len(summary['variants']['urllib_tauri']['commands']), 1 if fail_first else 5)
                for name in ['urllib_native', 'persistent_tauri']:
                    self.assertEqual(summary['variants'][name]['status'], 'passed')
                    self.assertEqual(summary['variants'][name]['lookup_shape'], {
                        'value_type': 'array', 'list_count': 1, 'reference_valid': True,
                    })
                self.assertNotIn('private', json.dumps(summary).lower())
                self.assertNotIn('http://', json.dumps(summary))
                self.assertEqual(timers[0][1], 20)
                self.assertEqual(timers[-1][1], 500 - clock[0])

    def test_console_only_explicit_w3c_unsupported_codes_are_unavailable(self):
        for code, expected in [('unknown command', True), ('unsupported operation', True),
                               ('unknown error', False), ('invalid session id', False)]:
            with self.subTest(code=code):
                body = io.BytesIO(json.dumps({'value': {'error': code, 'message': 'not retained'}}).encode())
                error = urllib.error.HTTPError('http://127.0.0.1/log', 500, 'driver error', {}, body)
                self.assertEqual(flows.unsupported_command(error), expected)
        error = urllib.error.HTTPError('http://127.0.0.1/log', 500, 'driver error', {}, io.BytesIO(b'not-json'))
        self.assertFalse(flows.unsupported_command(error))


@contextmanager
def webdriver_protocol_fixture():
    """Hosted-only HTTP framing fixture; never native/WebView application evidence."""
    records = []

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            records.append({'method': self.command, 'path': self.path, 'body': body,
                            'connection': self.headers.get('Connection'), 'content_type': self.headers.get('Content-Type'),
                            'peer': self.client_address})
            if self.path == '/disconnect':
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            status = 500 if self.path == '/unsupported' else 200
            value = {'error': 'unknown command'} if status == 500 else True
            payload = json.dumps({'value': value}).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.05), daemon=True)
    thread.start()
    client = flows.Native.__new__(flows.Native)
    client.profile = 0
    client.port = server.server_port
    client.connection = flows.http.client.HTTPConnection('127.0.0.1', client.port, timeout=1)
    try:
        yield client, records
    finally:
        client.connection.close()
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
        if thread.is_alive():
            raise RuntimeError('Protocol fixture shutdown deadline exceeded')


class NativeHttpProtocolTests(unittest.TestCase):
    def test_main_transport_preserves_w3c_payload_and_reuses_connection_without_close_header(self):
        with webdriver_protocol_fixture() as (client, records):
            self.assertTrue(client.request('GET', '/status', timeout=1))
            command = {'script': 'return true', 'args': []}
            self.assertTrue(client.request('POST', '/session/unit/execute/sync', command, timeout=1))
            self.assertEqual(len(records), 2)
            self.assertEqual(records[0]['peer'], records[1]['peer'])
            self.assertTrue(all(record['connection'] != 'close' for record in records))
            self.assertTrue(all(record['content_type'] == 'application/json' for record in records))
            self.assertEqual(records[1]['method'], 'POST')
            self.assertEqual(records[1]['path'], '/session/unit/execute/sync')
            self.assertEqual(json.loads(records[1]['body']), command)

    def test_main_transport_does_not_replay_disconnect_and_closes_failed_connection(self):
        with webdriver_protocol_fixture() as (client, records):
            with self.assertRaises(flows.http.client.RemoteDisconnected):
                client.request('GET', '/disconnect', timeout=1)
            self.assertEqual(len(records), 1)
            self.assertIsNone(client.connection.sock)
            # A separately issued future command may connect normally; the failed one was not replayed.
            self.assertTrue(client.request('GET', '/status', timeout=1))
            self.assertEqual(len(records), 2)
            self.assertEqual([record['path'] for record in records], ['/disconnect', '/status'])

    def test_main_transport_keeps_w3c_http_error_body_and_closes_connection(self):
        with webdriver_protocol_fixture() as (client, records):
            with self.assertRaises(urllib.error.HTTPError) as raised:
                client.request('POST', '/unsupported', {}, timeout=1)
            self.assertEqual(raised.exception.code, 500)
            self.assertTrue(flows.unsupported_command(raised.exception))
            self.assertIsNone(client.connection.sock)
            self.assertEqual(len(records), 1)


if __name__ == '__main__':
    unittest.main()
