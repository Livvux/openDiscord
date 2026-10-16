"""Bounded harness regressions and disposable hosted TLS gateway mechanisms."""
import io
import http.server
import socket
import threading
import json
import pathlib
import os
import signal
import ssl
import subprocess
import tempfile
import time
import types
import unittest
import urllib.error
from unittest.mock import Mock, patch
from contextlib import contextmanager

import native_app_flows as flows


class GatewayRecoveryTests(unittest.TestCase):
    @contextmanager
    def tls_fixture(self):
        """Private per-test certificate; never use caller TLS files or global trust."""
        with tempfile.TemporaryDirectory(prefix='native-gateway-tls-') as directory:
            certificate = pathlib.Path(directory) / 'gateway.crt'
            key = pathlib.Path(directory) / 'gateway.key'
            key.touch(mode=0o600)
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(key), '-out', str(certificate), '-days', '1',
                            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            key.chmod(0o600)
            yield {'NATIVE_TLS_CERT': str(certificate), 'NATIVE_TLS_KEY': str(key)}

    @contextmanager
    def identity(self, change=None):
        with tempfile.TemporaryDirectory() as directory:
            proc = pathlib.Path(directory)
            child = proc / '123'
            child.mkdir()
            fields = ['S', '456', '123', '123'] + ['0'] * 15 + ['789']
            (child / 'stat').write_text('123 (node) ' + ' '.join(fields))
            (child / 'status').write_text('Uid:\t' + '\t'.join([str(os.getuid())] * 4))
            (child / 'cmdline').write_bytes(b'node\0desktop/tests/app_proxy.mjs\0')
            (child / 'exe').symlink_to(proc / 'node')
            (child / 'cwd').symlink_to(flows.ROOT.parent)
            if change:
                change(child)
            with patch.dict(os.environ, {'NATIVE_APP_PROXY_PID': '123', 'NATIVE_APP_LAUNCHER_PID': '456'}), \
                    patch.object(flows, 'PROC_ROOT', proc), \
                    patch.object(flows.shutil, 'which', return_value=str(proc / 'node')), \
                    patch.object(os, 'pidfd_open', return_value=99, create=True) as opened, \
                    patch.object(os, 'close') as closed, \
                    patch.object(signal, 'pidfd_send_signal', create=True) as sent, \
                    patch.dict(flows.metadata, {}, clear=True):
                yield child, opened, closed, sent

    def test_gateway_identity_failures_close_descriptor_without_any_signals(self):
        changes = [lambda p: (p / 'cmdline').write_bytes(b'node\0private-arbitrary-script\0'),
                   lambda p: (p / 'status').write_text('Uid:\t-1\t-1\t-1\t-1'),
                   lambda p: (p / 'stat').write_text('123 (node) S 999 123 123 ' + '0 ' * 15 + '789'),
                   lambda p: (p / 'stat').write_text('123 (node) S 456 999 123 ' + '0 ' * 15 + '789'),
                   lambda p: (p / 'stat').write_text('123 (node) S 456 123 999 ' + '0 ' * 15 + '789'),
                   lambda p: (p / 'cwd').unlink(), lambda p: (p / 'exe').unlink()]
        for change in changes:
            with self.subTest(change=change), self.identity(change) as (_, opened, closed, sent):
                with self.assertRaises((ValueError, FileNotFoundError)):
                    flows.OwnedGateway()
                opened.assert_called_once_with(123, 0)
                closed.assert_called_once_with(99)
                sent.assert_not_called()
                self.assertFalse(flows.metadata['gateway_recovery']['ownership_valid'])

    def test_gateway_missing_or_invalid_handoff_never_opens_or_signals(self):
        for value in ['', '-123', '1', 'private', '１２３']:
            with self.subTest(value=value), self.identity() as (_, opened, closed, sent), \
                    patch.dict(os.environ, {'NATIVE_APP_PROXY_PID': value}):
                with self.assertRaises(ValueError):
                    flows.OwnedGateway()
                opened.assert_not_called()
                closed.assert_not_called()
                sent.assert_not_called()

    def test_production_fallback_missing_reaped_unsupported_or_replaced_never_signals(self):
        for failure in ['missing_start', 'reaped', 'unsupported', 'replacement_before_read', 'wrong_start',
                        'wrong_parent', 'wrong_uid', 'wrong_argv', 'wrong_cwd', 'wrong_exe', 'wrong_group', 'wrong_session']:
            with self.subTest(failure=failure), self.identity() as (child, opened, closed, sent), \
                    patch.dict(os.environ, {'NATIVE_APP_PROXY_START': '' if failure == 'missing_start' else '789'}), \
                    patch.object(os, 'kill') as numeric, patch.object(os, 'killpg') as group:
                if failure in {'reaped', 'unsupported'}:
                    opened.side_effect = ProcessLookupError() if failure == 'reaped' else NotImplementedError()
                if failure == 'replacement_before_read':
                    def open_replaced(*_):
                        stat = child / 'stat'
                        stat.write_text(stat.read_text().replace('789', '790'))
                        return 99
                    opened.side_effect = open_replaced
                if failure == 'wrong_start':
                    os.environ['NATIVE_APP_PROXY_START'] = '790'
                if failure in {'wrong_parent', 'wrong_group', 'wrong_session'}:
                    stat = child / 'stat'
                    fields = stat.read_text().rsplit(') ', 1)[1].split()
                    fields[{'wrong_parent': 1, 'wrong_group': 2, 'wrong_session': 3}[failure]] = '999'
                    stat.write_text('123 (node) ' + ' '.join(fields))
                if failure == 'wrong_uid':
                    (child / 'status').write_text('Uid:\t-1\t-1\t-1\t-1')
                if failure == 'wrong_argv':
                    (child / 'cmdline').write_bytes(b'node\0private-replacement\0')
                if failure in {'wrong_cwd', 'wrong_exe'}:
                    (child / failure.removeprefix('wrong_')).unlink()
                self.assertFalse(flows.resume_owned_gateway())
                sent.assert_not_called()
                numeric.assert_not_called()
                group.assert_not_called()
                self.assertNotIn('private-replacement', json.dumps(flows.metadata))
                if failure not in {'missing_start', 'reaped', 'unsupported'}:
                    closed.assert_called_once_with(99)

    def test_production_fallback_pins_before_reads_and_never_signals_reused_pid(self):
        for exited in [False, True]:
            with self.subTest(exited=exited), self.identity() as (child, opened, closed, sent), \
                    patch.dict(os.environ, {'NATIVE_APP_PROXY_START': '789'}), \
                    patch.object(os, 'kill') as numeric, patch.object(os, 'killpg') as group:
                reads = []
                record = flows.OwnedGateway._record

                def read(gateway):
                    opened.assert_called_once_with(123, 0)
                    reads.append(True)
                    return record(gateway)

                def resume(fd, number, info, flags):
                    self.assertTrue(reads)
                    self.assertEqual((fd, number, info, flags), (99, signal.SIGCONT, None, 0))
                    # Replacement appears after validation. The descriptor still targets only the original.
                    stat = child / 'stat'
                    stat.write_text(stat.read_text().replace('789', '790'))
                    if exited:
                        raise ProcessLookupError('private replacement record')

                sent.side_effect = resume
                with patch.object(flows.OwnedGateway, '_record', read):
                    self.assertFalse(flows.resume_owned_gateway())
                sent.assert_called_once_with(99, signal.SIGCONT, None, 0)
                closed.assert_called_once_with(99)
                numeric.assert_not_called()
                group.assert_not_called()
                self.assertNotIn('private replacement', json.dumps(flows.metadata))

    def test_production_fallback_allows_stopped_owned_gateway_and_sends_only_descriptor_cont(self):
        with self.identity() as (child, _, closed, sent), \
                patch.dict(os.environ, {'NATIVE_APP_PROXY_START': '789'}), \
                patch.object(os, 'kill') as numeric, patch.object(os, 'killpg') as group:
            stat = child / 'stat'
            stat.write_text(stat.read_text().replace('(node) S ', '(node) T '))

            def resume(*_):
                stat.write_text(stat.read_text().replace('(node) T ', '(node) S '))

            sent.side_effect = resume
            self.assertTrue(flows.resume_owned_gateway())
            sent.assert_called_once_with(99, signal.SIGCONT, None, 0)
            closed.assert_called_once_with(99)
            numeric.assert_not_called()
            group.assert_not_called()

    def test_gateway_changed_identity_never_signals_replacement(self):
        with self.identity() as (child, _, _, sent):
            gateway = flows.OwnedGateway()
            stat = child / 'stat'
            stat.write_text(stat.read_text().replace('789', '790'))
            with self.assertRaises(ValueError):
                with gateway.paused():
                    self.fail('Replacement must never be paused')
            sent.assert_not_called()
            gateway.close()

    def test_gateway_resume_obligation_precedes_stop_and_all_exceptions_resume(self):
        for failure in ['stop_applied', 'observation', 'global_deadline', 'interrupt']:
            with self.subTest(failure=failure), self.identity() as (_, _, _, sent):
                gateway = flows.OwnedGateway()
                events = []

                def send(fd, number, info, flags):
                    self.assertEqual((fd, info, flags), (99, None, 0))
                    self.assertTrue(gateway.resume_required)
                    events.append(number)
                    if number == signal.SIGSTOP and failure == 'stop_applied':
                        raise RuntimeError('private process metadata')

                sent.side_effect = send
                with patch.object(gateway, 'stopped', return_value=False), \
                        patch.object(gateway, 'await_state'), \
                        patch.object(signal, 'getitimer', return_value=(400, 0)), \
                        patch.object(signal, 'setitimer') as timer, \
                        patch.object(signal, 'signal', return_value=flows.deadline), \
                        patch.object(signal, 'pthread_sigmask', return_value=set(), create=True):
                    with self.assertRaises(BaseException):
                        with gateway.paused():
                            raise {'observation': ValueError, 'global_deadline': flows.NativeDeadlineExpired,
                                   'interrupt': KeyboardInterrupt}[failure]()
                    self.assertEqual(events, [signal.SIGSTOP, signal.SIGCONT])
                    self.assertEqual(timer.call_args_list[0].args, (signal.ITIMER_REAL, 8))
                    self.assertFalse(gateway.resume_required)
                    self.assertTrue(flows.metadata['gateway_recovery']['resumed'])
                    self.assertNotIn('private', json.dumps(flows.metadata))
                gateway.close()

    def test_gateway_state_read_deadline_is_one_second(self):
        gateway = flows.OwnedGateway.__new__(flows.OwnedGateway)
        gateway.stopped = Mock(return_value=False)
        clock = [0.0]
        with patch.object(time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            with self.assertRaises(TimeoutError):
                gateway.await_state(True)
        self.assertLessEqual(clock[0], 1.01)

    def test_public_probe_returns_only_allowlisted_outcome_and_has_native_deadline(self):
        for value in [{'outcome': 'deadline', 'private': 'sentinel'},
                      {'outcome': 'network_error', 'status_class': 'sentinel'},
                      {'outcome': 'http_response', 'status_class': 2, 'headers': 'sentinel'}]:
            client = types.SimpleNamespace(command=Mock(return_value=value))
            with patch.object(time, 'monotonic', return_value=10):
                result = flows.gateway_probe(client, 40)
            self.assertNotIn('sentinel', json.dumps(result))
            call = client.command.call_args
            self.assertEqual(call.kwargs, {'timeout': 2})
            self.assertEqual(call.args[2]['args'], [1000])
            self.assertIn("cache: 'no-store'", call.args[2]['script'])
            self.assertIn('controller.abort()', call.args[2]['script'])

    def test_single_send_pending_recovery_and_every_failure_resume_without_replay(self):
        ready = {'at_messages': True, 'log_visible': True, 'visibility': 'visible',
                 'selection_count': 1, 'target_selection_count': 1, 'private_log_count': 1,
                 'textarea_count': 1, 'send_control_count': 1, 'alert_count': 0,
                 'decrypt_error_count': 0, 'textarea_enabled': True, 'send_enabled': True,
                 'draft_matches': True, 'expected_plaintext_count': 0}
        for failure in [None, 'probe', 'click', 'sender_dom', 'recipient_dom', 'global', 'pending_budget', 'duplicate']:
            with self.subTest(failure=failure):
                clock = [0.0]
                events = []
                paused = [False]
                sent = [False]
                alice, bob = types.SimpleNamespace(profile=0), types.SimpleNamespace(profile=1)

                @contextmanager
                def pause():
                    paused[0] = True
                    events.append('stop')
                    try:
                        yield
                    finally:
                        paused[0] = False
                        events.append('resume')

                def command(method, path, body=None, timeout=None):
                    self.assertLessEqual(timeout, 2)
                    if path == '/elements':
                        return [{flows.ELEMENT: 'control'}]
                    if path.endswith('/enabled'):
                        return True
                    if path.endswith('/click'):
                        events.append('send')
                        sent[0] = True
                        self.assertTrue(paused[0])
                        if failure == 'click':
                            raise flows.http.client.RemoteDisconnected()
                    return True

                alice.command = Mock(side_effect=command)

                def observe(client, expected, timeout):
                    self.assertLessEqual(timeout, 2)
                    if paused[0]:
                        if failure in ['global', 'pending_budget']:
                            if failure == 'global':
                                raise flows.NativeDeadlineExpired()
                            clock[0] = 31
                            flows.gateway_timeout(30)
                        if failure == ('sender_dom' if client.profile == 0 else 'recipient_dom'):
                            raise ValueError('private DOM')
                        return {**ready, **({'textarea_enabled': False, 'send_enabled': False,
                                             'disabled_control_count': 2} if client.profile == 0 else {})}
                    if sent[0]:
                        return {**ready, 'expected_plaintext_count': 2 if failure == 'duplicate' else 1,
                                'own_plaintext_present': True, 'draft_empty': True}
                    return ready

                def probe(client, end):
                    if paused[0]:
                        return {'outcome': 'http_response', 'status_class': 2} if failure == 'probe' else {'outcome': 'deadline'}
                    return {'outcome': 'http_response', 'status_class': 2}

                with patch.object(flows, 'dm_delivery_state', side_effect=observe), \
                        patch.object(flows, 'gateway_probe', side_effect=probe), \
                        patch.object(signal, 'getitimer', return_value=(400, 0)), \
                        patch.object(time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.dict(flows.metadata, {'gateway_recovery': {'ownership_valid': True}}, clear=True):
                    gateway = types.SimpleNamespace(paused=pause)
                    if failure:
                        with self.assertRaises(Exception):
                            flows.gateway_recovery(alice, bob, gateway, 'private sentinel', 'previous sentinel')
                    else:
                        flows.gateway_recovery(alice, bob, gateway, 'private sentinel', 'previous sentinel')
                        self.assertTrue(flows.metadata['gateway_recovery']['delivered_once'])
                    self.assertFalse(paused[0])
                    self.assertEqual(events.count('send'), 0 if failure == 'probe' else 1)
                    self.assertEqual(events.count('resume'), 1)
                    self.assertNotIn('sentinel', json.dumps(flows.metadata))

    def test_remaining_global_budget_rejects_before_any_native_action(self):
        alice, bob, gateway = Mock(), Mock(), Mock()
        with patch.object(signal, 'getitimer', return_value=(209, 0)):
            with self.assertRaises(TimeoutError):
                flows.gateway_recovery(alice, bob, gateway, 'private', 'previous')
        alice.command.assert_not_called()
        gateway.paused.assert_not_called()

    def test_workflow_cleanup_resumes_owned_gateway_before_term_and_keeps_deadlines(self):
        workflow = (flows.ROOT.parent / '.github/workflows/native-app-flows.yml').read_text()
        cleanup = workflow.split('          cleanup() {', 1)[1].split('          trap cleanup EXIT', 1)[0]
        self.assertLess(cleanup.index('--resume-owned-gateway'), cleanup.index('kill --'))
        self.assertLess(cleanup.index('kill --'), cleanup.index('kill -KILL'))
        self.assertNotIn('kill -CONT', workflow)
        self.assertIn('NATIVE_APP_PROXY_START="${proxy_start:-}"', cleanup)
        self.assertIn('NATIVE_APP_PROXY_PID="$proxy_pid" NATIVE_APP_LAUNCHER_PID="$$"', workflow)
        self.assertIn("trap 'exit 143' TERM", workflow)
        self.assertIn("trap 'exit 130' INT", workflow)
        self.assertIn('timeout-minutes: 12', workflow)

    @unittest.skipUnless(os.uname().sysname == 'Linux', 'Hosted Linux pidfd mechanism only')
    def test_hosted_shell_fallback_resumes_stopped_child_before_termination(self):
        workflow = (flows.ROOT.parent / '.github/workflows/native-app-flows.yml').read_text()
        functions = workflow.split('          cleanup() {', 1)[1].split('          trap cleanup EXIT', 1)[0]
        script = 'set -euo pipefail\ncleanup() {' + functions + '''
          trap cleanup EXIT
          trap 'exit 143' TERM
          trap 'exit 130' INT
          setsid node desktop/tests/app_proxy.mjs >/dev/null 2>&1 &
          proxy_pid=$!
          IFS= read -r proxy_record < "/proc/$proxy_pid/stat"
          read -ra proxy_fields <<< "${proxy_record##*) }"
          proxy_start=${proxy_fields[19]}
          for attempt in $(seq 1 20); do
            if curl --silent --output /dev/null --cacert "$NATIVE_TLS_CERT" https://localhost:9443/sign-in; then break; fi
            sleep .05
          done
          curl --silent --output /dev/null --cacert "$NATIVE_TLS_CERT" https://localhost:9443/sign-in
          NATIVE_APP_PROXY_PID="$proxy_pid" NATIVE_APP_LAUNCHER_PID="$$" python3 -c 'import sys, signal; sys.path.insert(0, "desktop/tests"); from native_app_flows import OwnedGateway; gateway = OwnedGateway(); signal.pidfd_send_signal(gateway.fd, signal.SIGSTOP, None, 0); gateway.await_state(True); gateway.close()'
          kill() {
            case "$1" in
              --)
                IFS= read -r record < "/proc/$proxy_pid/stat"
                read -ra fields <<< "${record##*) }"
                case "${fields[0]}" in T|t) echo STOPPED;; *) echo RESUMED;; esac
                echo TERM;;
              -KILL) echo KILL;;
            esac
            builtin kill "$@"
          }
          exit 143
        '''
        with self.tls_fixture() as tls:
            result = subprocess.run(['bash', '-c', script], cwd=flows.ROOT.parent,
                                    env={**os.environ, **tls}, capture_output=True, timeout=5)
        diagnostic = {'exitcode': result.returncode,
                      'tls_env_missing': b'NATIVE_TLS_CERT: unbound variable' in result.stderr,
                      'stderr_present': bool(result.stderr)}
        self.assertEqual(result.returncode, 143, diagnostic)
        self.assertEqual(result.stdout.decode().splitlines(), ['RESUMED', 'TERM', 'KILL'])

    @unittest.skipUnless(os.uname().sysname == 'Linux', 'Hosted Linux pidfd mechanism only')
    def test_hosted_real_linux_pidfd_gateway_blackout_and_restore(self):
        """Actual owned TLS process capability; not a substitute for native DM acceptance."""
        with self.tls_fixture() as tls:
            self.assert_real_gateway_blackout_and_restore(tls)

    def assert_real_gateway_blackout_and_restore(self, tls):
        context = ssl.create_default_context(cafile=tls['NATIVE_TLS_CERT'])
        process = subprocess.Popen(['node', 'desktop/tests/app_proxy.mjs'], cwd=flows.ROOT.parent,
                                   env={**os.environ, **tls}, start_new_session=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        gateway = None

        def health():
            try:
                with flows.urllib.request.urlopen(flows.ORIGIN + '/sign-in', context=context, timeout=.3) as response:
                    return response.status
            except urllib.error.HTTPError as error:
                return error.code

        try:
            with patch.dict(os.environ, {'NATIVE_APP_PROXY_PID': str(process.pid),
                                         'NATIVE_APP_LAUNCHER_PID': str(os.getpid())}), \
                    patch.dict(flows.metadata, {}, clear=True):
                end = time.monotonic() + 3
                while True:
                    try:
                        if health() == 502:
                            break
                    except (urllib.error.URLError, TimeoutError):
                        pass
                    if time.monotonic() >= end:
                        self.fail('Owned gateway readiness deadline exceeded')
                    time.sleep(.05)
                gateway = flows.OwnedGateway()
                old_handler = signal.signal(signal.SIGALRM, flows.deadline)
                signal.setitimer(signal.ITIMER_REAL, 10)
                try:
                    with gateway.paused():
                        self.assertTrue(gateway.stopped())
                        with self.assertRaises((TimeoutError, urllib.error.URLError)):
                            health()
                    self.assertFalse(gateway.stopped())
                    self.assertEqual(health(), 502)
                    gateway.resume_required = True
                    signal.pidfd_send_signal(gateway.fd, signal.SIGSTOP, None, 0)
                    gateway.await_state(True)
                    resumed = subprocess.run([flows.sys.executable, str(flows.ROOT / 'tests/native_app_flows.py'),
                                              '--resume-owned-gateway'], cwd=flows.ROOT.parent, capture_output=True,
                                             env={**os.environ, 'NATIVE_APP_PROXY_START': gateway.start}, timeout=3)
                    self.assertEqual((resumed.returncode, resumed.stdout, resumed.stderr), (0, b'', b''))
                    gateway.await_state(False)
                    gateway.resume_required = False
                    self.assertEqual(health(), 502)
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
                    signal.signal(signal.SIGALRM, old_handler)
        finally:
            try:
                if gateway is not None:
                    try:
                        gateway.resume()
                    finally:
                        gateway.close()
            finally:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)


class NativeSupportTests(unittest.TestCase):
    def test_encrypted_send_waits_for_own_committed_ui_before_receiver_without_replay(self):
        ready = {'at_messages': True, 'log_visible': True, 'own_plaintext_present': True,
                 'draft_empty': True, 'textarea_enabled': True, 'selection_count': 1,
                 'target_selection_count': 1, 'private_log_count': 1, 'textarea_count': 1,
                 'alert_count': 0, 'decrypt_error_count': 0}
        failures = [{'draft_empty': False}, {'textarea_enabled': False}, {'alert_count': 1},
                    {'own_plaintext_present': False}, {'decrypt_error_count': 1},
                    {'at_messages': False}, {'log_visible': False}, {'selection_count': 2},
                    {'target_selection_count': 0}, {'private_log_count': 2}, {'textarea_count': 0}]
        for failure in [None, *failures]:
            with self.subTest(failure=failure):
                alice = flows.Native.__new__(flows.Native)
                alice.profile = 0
                alice.fill, alice.click = Mock(), Mock()
                bob = types.SimpleNamespace(profile=1, text=Mock(return_value=True))
                clock = [0.0]
                observations = []

                def observe(client, message, timeout):
                    self.assertIs(client, alice)
                    self.assertEqual(message, 'private fixture')
                    self.assertLessEqual(timeout, 2)
                    alice.click.assert_called_once_with('Send encrypted message')
                    bob.text.assert_not_called()
                    clock[0] += 10
                    observations.append(True)
                    # A ready run still observes an asynchronous pending state first.
                    return {**ready, **(failure or ({'draft_empty': False} if len(observations) == 1 else {}))}

                with patch.object(flows, 'persist'), patch.dict(flows.metadata, {}, clear=True), \
                        patch.object(flows, 'dm_delivery_state', side_effect=observe), \
                        patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(flows.time, 'sleep'):
                    if failure is None:
                        flows.send_and_receive_dm(alice, bob, 'private fixture')
                        bob.text.assert_called_once_with('private fixture')
                    else:
                        with self.assertRaises(TimeoutError):
                            flows.send_and_receive_dm(alice, bob, 'private fixture')
                        bob.text.assert_not_called()
                        self.assertEqual(clock[0], 30)
                        self.assertEqual(flows.metadata['dm_action']['action'], 'await_encrypted_send_complete')
                    alice.fill.assert_called_once_with('Encrypted message', 'private fixture')
                    alice.click.assert_called_once_with('Send encrypted message')
                    self.assertNotIn('private fixture', json.dumps(flows.metadata))

    def test_encrypted_sender_global_expiry_propagates_without_receiver_or_second_send(self):
        alice = flows.Native.__new__(flows.Native)
        alice.profile = 0
        alice.fill, alice.click = Mock(), Mock()
        bob = types.SimpleNamespace(profile=1, text=Mock())
        with patch.object(flows, 'persist'), patch.dict(flows.metadata, {}, clear=True), \
                patch.object(flows, 'dm_delivery_state', side_effect=flows.NativeDeadlineExpired()):
            with self.assertRaises(flows.NativeDeadlineExpired):
                flows.send_and_receive_dm(alice, bob, 'private fixture')
        alice.click.assert_called_once_with('Send encrypted message')
        bob.text.assert_not_called()

    def test_dm_delivery_observation_redacts_both_peers_and_does_not_treat_no_alert_as_delivery(self):
        private = 'private message SAS JWT key draft native payload'
        for profile in [0, 1]:
            for visibility in ['visible', 'hidden', private]:
                with self.subTest(profile=profile, visibility=visibility):
                    snapshot = {'visibility': visibility, 'private_log_count': 1, 'message_row_count': 1,
                                'expected_plaintext_present': False, 'own_plaintext_present': False,
                                'decrypt_error_count': 1, 'alert_count': 0, 'draft_empty': False,
                                'textarea_enabled': True, 'selection_count': True, 'textarea_count': -1,
                                'send_control_count': 10001, 'send_enabled': private, 'text': private,
                                'url': private, 'SAS': private, 'draft': private, 'native_payload': private}
                    client = types.SimpleNamespace(profile=profile, command=Mock(return_value=snapshot))
                    result = flows.dm_delivery_state(client, private, timeout=.25)
                    self.assertEqual(result, {'profile': profile, 'visibility': visibility if visibility in {'visible', 'hidden'} else 'other',
                        'private_log_count': 1, 'message_row_count': 1, 'expected_plaintext_present': False,
                        'own_plaintext_present': False, 'decrypt_error_count': 1, 'alert_count': 0,
                        'draft_empty': False, 'textarea_enabled': True})
                    self.assertNotIn(private, json.dumps(result))
                    self.assertEqual(client.command.call_args.args[:2], ('POST', '/execute/sync'))
                    self.assertEqual(client.command.call_args.kwargs, {'timeout': .25})

    def test_both_dm_peer_diagnostics_share_budget_preserve_failure_and_are_failure_only(self):
        clients = [types.SimpleNamespace(profile=index) for index in range(3)]
        for budget, fail_first in [(10, False), (3, False), (10, True)]:
            with self.subTest(budget=budget, fail_first=fail_first):
                clock = [0.0]
                seen = []
                failed_request = {'profile': 1, 'method': 'POST', 'endpoint': 'sync_script'}

                def observe(client, message, timeout):
                    self.assertEqual(message, 'private fixture')
                    seen.append((client.profile, timeout))
                    clock[0] += timeout
                    flows.metadata['last_native_request'] = {'profile': client.profile, 'endpoint': 'sync_script'}
                    if fail_first and client.profile == 0:
                        raise ValueError('private fixture')
                    return {'profile': client.profile, 'visibility': 'hidden' if client.profile == 1 else 'visible'}

                with patch.dict(flows.metadata, {'last_native_request': failed_request}, clear=True), \
                        patch.dict(flows.results, {name: {'status': 'passed'} for name in flows.CASES}), \
                        patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(flows, 'dm_delivery_state', side_effect=observe) as dm, \
                        patch.object(flows, 'dm_diagnostics') as community, \
                        patch.object(flows, 'transport_diagnostics', return_value={}) as transport:
                    flows.failure_diagnostics(clients, budget=budget, delivery_message='private fixture')
                    dm.assert_not_called()
                    self.assertNotIn('dm_peer_diagnostics', flows.metadata)
                    transport.reset_mock()
                    flows.results['dm_sas_delivery'] = {'status': 'failed'}
                    flows.failure_diagnostics(clients, budget=budget, delivery_message='private fixture')
                    self.assertEqual(seen, [(0, 2), (1, min(2, budget - 2))])
                    self.assertEqual(flows.metadata['dm_failed_request'], failed_request)
                    self.assertEqual(len(flows.metadata['dm_peer_diagnostics']), 2)
                    if fail_first:
                        self.assertEqual(flows.metadata['dm_peer_diagnostics'][0], {'profile': 0, 'error_type': 'ValueError'})
                    self.assertNotIn('private fixture', json.dumps(flows.metadata))
                    community.assert_not_called()
                    transport.assert_called_once_with(clients, budget=max(0, budget - 4))

    def test_dm_peer_diagnostics_global_expiry_stops_remaining_probes(self):
        clients = [types.SimpleNamespace(profile=index) for index in range(2)]
        with patch.dict(flows.metadata, {}, clear=True), \
                patch.dict(flows.results, {name: {'status': 'failed' if name == 'dm_sas_delivery' else 'passed'} for name in flows.CASES}), \
                patch.object(flows, 'dm_delivery_state', side_effect=flows.NativeDeadlineExpired()) as dm, \
                patch.object(flows, 'transport_diagnostics') as transport:
            with self.assertRaises(flows.NativeDeadlineExpired):
                flows.failure_diagnostics(clients, delivery_message='private fixture')
            dm.assert_called_once()
            transport.assert_not_called()

    def test_enabled_inputs_wait_without_writes_then_send_once_or_fail_without_replay(self):
        for operation in ['fill', 'upload']:
            for outcome in ['ready', 'disabled', 'write_failure']:
                with self.subTest(operation=operation, outcome=outcome):
                    client = flows.Native.__new__(flows.Native)
                    client.element = Mock(return_value='control')
                    clock = [0.0]
                    events = []

                    def command(method, path, body=None):
                        events.append((method, path, body))
                        if path.endswith('/enabled'):
                            self.assertEqual(method, 'GET')
                            if outcome == 'disabled':
                                clock[0] += 10
                                return False
                            return len(events) >= 3
                        self.assertEqual((method, path), ('POST', '/element/control/value'))
                        self.assertEqual(len(events), 4)
                        if outcome == 'write_failure':
                            raise flows.http.client.RemoteDisconnected()

                    client.command = command
                    with patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                            patch.object(flows.time, 'sleep'):
                        def act():
                            if operation == 'fill':
                                client.fill('Encrypted message', 'test-message')
                            else:
                                client.upload('//input[@type="file"]', pathlib.Path('/temporary/recovery.json'))
                        if outcome == 'ready':
                            act()
                        else:
                            with self.assertRaises(TimeoutError if outcome == 'disabled' else flows.http.client.RemoteDisconnected):
                                act()
                    writes = [event for event in events if event[0] == 'POST']
                    self.assertEqual(len(writes), 0 if outcome == 'disabled' else 1)
                    client.element.assert_called_once()
                    if outcome == 'disabled':
                        self.assertEqual(clock[0], 30)

    def test_sender_commit_excludes_pending_and_requires_unique_visible_uuid(self):
        message_id = '018f1234-1234-7000-8000-123456789abc'
        for outcome in ['committed', 'pending', 'ambiguous', 'invalid_id', 'hidden']:
            with self.subTest(outcome=outcome):
                client = flows.Native.__new__(flows.Native)
                clock = [0.0]
                lookups = [0]
                events = []

                def command(method, path, body=None):
                    events.append((method, path))
                    if path == '/elements':
                        lookups[0] += 1
                        self.assertEqual(body, {'using': 'xpath', 'value':
                            '//li[@data-message-id][.//div[normalize-space(.)="Native community greeting"]]'})
                        # Actual PendingItem has no data-message-id, so is absent from this result.
                        if outcome == 'pending' or (outcome == 'committed' and lookups[0] == 1):
                            clock[0] += 10
                            return []
                        return [{flows.ELEMENT: 'row'}] * (2 if outcome == 'ambiguous' else 1)
                    if path == '/element/row/attribute/data-message-id':
                        return 'pending-local-row' if outcome == 'invalid_id' else message_id
                    self.assertEqual((method, path), ('GET', '/element/row/displayed'))
                    if outcome == 'hidden':
                        clock[0] += 10
                        return False
                    return True

                client.command = command
                with patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(flows.time, 'sleep'):
                    if outcome == 'committed':
                        self.assertEqual(client.wait_sent_community_message(), message_id)
                        self.assertEqual(lookups[0], 2)
                    else:
                        with self.assertRaises(TimeoutError if outcome in ['pending', 'hidden'] else ValueError):
                            client.wait_sent_community_message()
                self.assertTrue(all(method == 'GET' or path == '/elements' for method, path in events))
                if outcome in ['pending', 'hidden']:
                    self.assertEqual(clock[0], 30)

    def test_dm_entry_requires_sender_commit_and_channel_readiness_before_pointer_link(self):
        message_id = '018f1234-1234-7000-8000-123456789abc'
        path = '/app/c/' + message_id + '/' + message_id
        for outcome in ['ready', 'uncommitted', 'ambiguous', 'wrong_document']:
            with self.subTest(outcome=outcome):
                alice, bob = Mock(profile=0), Mock(profile=1)
                bob.element.return_value = 'composer'
                bob.wait_sent_community_message.return_value = message_id
                if outcome in ['uncommitted', 'ambiguous']:
                    bob.wait_sent_community_message.side_effect = TimeoutError() if outcome == 'uncommitted' else ValueError()
                if outcome == 'wrong_document':
                    alice.wait_channel.side_effect = TimeoutError()
                sequence = Mock()
                for name, method in [('send', bob.click), ('commit', bob.wait_sent_community_message),
                                     ('navigate', alice.goto), ('channel', alice.wait_channel),
                                     ('link', alice.open_private_message)]:
                    sequence.attach_mock(method, name)
                with patch.object(flows, 'persist'), patch.dict(flows.metadata, {}, clear=True):
                    if outcome == 'ready':
                        flows.open_dm_from_community(alice, bob, path)
                    else:
                        with self.assertRaises((TimeoutError, ValueError)):
                            flows.open_dm_from_community(alice, bob, path)
                    bob.click.assert_called_once_with('Send message')
                    if outcome in ['uncommitted', 'ambiguous']:
                        alice.goto.assert_not_called()
                        self.assertEqual(flows.metadata['dm_action'], {'profile': 1, 'action': 'await_sender_message_commit'})
                    else:
                        alice.goto.assert_called_once_with(path)
                        alice.wait_channel.assert_called_once_with(path)
                    if outcome != 'ready':
                        alice.open_private_message.assert_not_called()
                    else:
                        alice.open_private_message.assert_called_once_with(message_id)
                        self.assertEqual([call[0] for call in sequence.mock_calls],
                                         ['send', 'commit', 'navigate', 'channel', 'link'])

    def test_channel_destination_rejects_wrong_route_settings_and_missing_or_ambiguous_content(self):
        community = '018f1234-1234-7000-8000-123456789abc'
        channel = '018f1234-1234-7000-8000-123456789abd'
        path = '/app/c/' + community + '/' + channel
        snapshot = {'url': flows.ORIGIN + path, 'channel_log_count': 1, 'composer_count': 1}
        self.assertTrue(flows.channel_destination_reached(snapshot, path))
        for changes in [{'url': 'https://other.invalid' + path}, {'url': flows.ORIGIN + path + '/extra'},
                        {'url': flows.ORIGIN + '/app/c/' + community + '/settings'},
                        {'url': flows.ORIGIN + '/app/c/' + community + '/' + community},
                        {'channel_log_count': 0}, {'channel_log_count': 2},
                        {'composer_count': 0}, {'composer_count': 2}]:
            with self.subTest(changes=changes):
                self.assertFalse(flows.channel_destination_reached({**snapshot, **changes}, path))
        settings = '/app/c/' + community + '/settings'
        self.assertFalse(flows.channel_destination_reached({**snapshot, 'url': flows.ORIGIN + settings}, settings))

    def test_channel_readiness_uses_same_document_snapshot_and_existing_30_second_budget(self):
        identifier = '018f1234-1234-7000-8000-123456789abc'
        path = '/app/c/' + identifier + '/' + identifier
        for ready in [False, True]:
            with self.subTest(ready=ready):
                client = flows.Native.__new__(flows.Native)
                clock = [0.0]
                calls = []

                def command(method, endpoint, body, *, timeout):
                    calls.append((method, endpoint))
                    self.assertEqual((method, endpoint), ('POST', '/execute/sync'))
                    self.assertLessEqual(timeout, 2)
                    clock[0] += 10
                    return {'url': flows.ORIGIN + path, 'channel_log_count': 1,
                            'composer_count': 1 if ready and len(calls) == 2 else 0}

                client.command = command
                with patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(flows.time, 'sleep'):
                    if ready:
                        client.wait_channel(path)
                        self.assertEqual(len(calls), 2)
                    else:
                        with self.assertRaises(TimeoutError):
                            client.wait_channel(path)
                        self.assertEqual(clock[0], 30)

    def test_dm_real_pointer_reveals_only_the_uniquely_scoped_message_link(self):
        for failure in [None, 'ambiguous_message', 'ambiguous_link', 'unsupported', 'disconnected']:
            with self.subTest(failure=failure):
                client = flows.Native.__new__(flows.Native)
                client.profile = 0
                hovered = False
                events = []

                def command(method, path, body=None):
                    nonlocal hovered
                    events.append((method, path, body))
                    if (method, path) == ('POST', '/elements'):
                        # A global author-link lookup would also select an unrelated message.
                        self.assertEqual(body, {'using': 'xpath', 'value':
                            '//li[@data-message-id][.//div[normalize-space(.)="Native community greeting"]][@data-message-id="018f1234-1234-7000-8000-123456789abc"]'})
                        return [{flows.ELEMENT: 'message'}] * (2 if failure == 'ambiguous_message' else 1)
                    if (method, path) == ('GET', '/element/message/displayed'):
                        return True
                    if (method, path) == ('POST', '/actions'):
                        self.assertFalse(hovered)
                        self.assertEqual(body, {'actions': [{'type': 'pointer', 'id': 'dm-mouse',
                            'parameters': {'pointerType': 'mouse'}, 'actions': [{'type': 'pointerMove',
                            'origin': {flows.ELEMENT: 'message'}, 'x': 0, 'y': 0, 'duration': 0}]}]})
                        if failure == 'unsupported':
                            raise urllib.error.HTTPError('private-url', 404, '', {}, io.BytesIO(json.dumps(
                                {'value': {'error': 'unsupported operation', 'message': 'private-value'}}).encode()))
                        if failure == 'disconnected':
                            raise flows.http.client.RemoteDisconnected()
                        hovered = True
                        return None
                    if (method, path) == ('POST', '/element/message/elements'):
                        self.assertTrue(hovered)
                        self.assertEqual(body, {'using': 'xpath', 'value': './/a[@aria-label="Message Native Bob privately"]'})
                        return [{flows.ELEMENT: 'scoped-link'}] * (2 if failure == 'ambiguous_link' else 1)
                    if (method, path) == ('GET', '/element/scoped-link/displayed'):
                        return hovered
                    if (method, path) == ('GET', '/element/scoped-link/enabled'):
                        self.assertEqual(events[-2][:2], ('GET', '/element/scoped-link/displayed'))
                        return True
                    if (method, path) == ('POST', '/element/scoped-link/click'):
                        self.assertEqual(events[-2][:2], ('GET', '/element/scoped-link/enabled'))
                        return None
                    self.fail('Unexpected command: no JS, style mutation, navigation or action replay allowed')

                client.command = command
                with patch.object(flows, 'persist'), patch.dict(flows.metadata, {}, clear=True):
                    if failure:
                        with self.assertRaises((ValueError, urllib.error.HTTPError, flows.http.client.RemoteDisconnected)):
                            client.open_private_message("018f1234-1234-7000-8000-123456789abc")
                    else:
                        client.open_private_message("018f1234-1234-7000-8000-123456789abc")
                    self.assertEqual(sum(path == '/actions' for _, path, _ in events),
                                     0 if failure == 'ambiguous_message' else 1)
                    self.assertEqual(sum(path.endswith('/click') for _, path, _ in events), 0 if failure else 1)
                    if failure == 'unsupported':
                        self.assertEqual(flows.metadata['dm_pointer_capability'], 'unsupported')
                    self.assertNotIn('private-value', json.dumps(flows.metadata))

    def test_dm_hidden_link_times_out_without_second_hover_or_click(self):
        client = flows.Native.__new__(flows.Native)
        client.profile = 0
        events = []
        clock = [0.0]

        def command(method, path, body=None):
            events.append(path)
            if path == '/elements':
                return [{flows.ELEMENT: 'message'}]
            if path == '/element/message/elements':
                return [{flows.ELEMENT: 'link'}]
            if path == '/element/message/displayed':
                return True
            if path == '/element/link/displayed':
                clock[0] += 10
                return False
            if path == '/actions':
                return None
            self.fail('Hidden link must not be enabled or clicked')

        client.command = command
        with patch.object(flows, 'persist'), patch.dict(flows.metadata, {}, clear=True), \
                patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(flows.time, 'sleep'):
            with self.assertRaises(TimeoutError):
                client.open_private_message("018f1234-1234-7000-8000-123456789abc")
            self.assertEqual(clock[0], 30)
            self.assertEqual(events.count('/actions'), 1)
            self.assertEqual(flows.metadata['dm_action']['action'], 'await_private_message_link_visible')

    def test_dm_diagnostic_allowlists_actions_routes_counts_and_booleans(self):
        private = 'private-payload-never-retained'
        client = types.SimpleNamespace(profile=1, command=Mock(return_value={
            'route': private, 'message_count': 1, 'link_count': 1, 'verification_count': True,
            'alert_count': -1, 'message_hovered': True, 'link_zero_opacity': False,
            'link_has_rect': private, 'text': private, 'code': private, 'url': private,
        }))
        with patch.object(flows, 'persist'), patch.dict(flows.metadata, {}, clear=True):
            for profile, action in [(0, private), (3, 'send_message_request'), (True, 'send_message_request')]:
                with self.assertRaises(ValueError):
                    flows.dm_progress(profile, action)
            self.assertEqual(flows.metadata, {})
            flows.dm_progress(1, 'accept_message_request')
            self.assertEqual(flows.metadata['dm_action'], {'profile': 1, 'action': 'accept_message_request'})
            result = flows.dm_diagnostics(client, timeout=.5)
        self.assertEqual(result, {'profile': 1, 'route': 'other', 'message_count': 1, 'link_count': 1,
                                 'message_hovered': True, 'link_zero_opacity': False})
        self.assertNotIn(private, json.dumps(result))
        client.command.assert_called_once()
        self.assertEqual(client.command.call_args.args[:2], ('POST', '/execute/sync'))
        self.assertEqual(client.command.call_args.kwargs['timeout'], .5)

    def test_dm_diagnostic_retains_only_fixed_route_kinds_and_bounded_sender_counts(self):
        private = 'private-route-or-message-id'
        for route in ['channel', 'community-settings', private]:
            client = types.SimpleNamespace(profile=1, command=Mock(return_value={
                'route': route, 'pending_count': 1, 'channel_log_count': 1, 'composer_count': 1,
                'alert_count': 10001, 'message_id': private, 'pending_text': private,
            }))
            result = flows.dm_diagnostics(client)
            self.assertEqual(result, {'profile': 1, 'route': route if route != private else 'other',
                                     'pending_count': 1, 'channel_log_count': 1, 'composer_count': 1})
            self.assertNotIn(private, json.dumps(result))

    def test_dm_failure_observation_shares_auth_transport_budget_and_never_runs_on_success(self):
        client = types.SimpleNamespace(profile=2)
        clock = [0.0]

        def observe(_client, timeout):
            self.assertEqual(timeout, 2)
            clock[0] += timeout
            return {'route': 'messages'}

        with patch.dict(flows.metadata, {'dm_action': {'profile': 2}, 'auth_action': {'profile': 2}}, clear=True), \
                patch.dict(flows.results, {name: {'status': 'passed'} for name in flows.CASES}), \
                patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(flows, 'dm_diagnostics', side_effect=observe) as dm, \
                patch.object(flows, 'auth_diagnostics', side_effect=observe) as auth, \
                patch.object(flows, 'transport_diagnostics', return_value={}) as transport:
            flows.failure_diagnostics([client])
            dm.assert_not_called()
            auth.assert_not_called()
            transport.reset_mock()
            flows.results['dm_recovery'] = {'status': 'failed'}
            flows.failure_diagnostics([client])
            dm.assert_called_once()
            auth.assert_called_once()
            transport.assert_called_once_with([client], budget=6)
            dm.side_effect = flows.NativeDeadlineExpired()
            auth.reset_mock()
            transport.reset_mock()
            with self.assertRaises(flows.NativeDeadlineExpired):
                flows.failure_diagnostics([client])
            auth.assert_not_called()
            transport.assert_not_called()

    def test_save_requires_causal_unique_visible_dialog_and_never_replays_input(self):
        dialog, foreign = '100001', '100002'
        cases = [
            ('preexisting', [[foreign]], False, 'preexisting_dialog', 0, 0, 0),
            ('hidden_then_visible', [[], [], [dialog], [dialog], [dialog], []], False, 'none', 1, 1, 1),
            ('multiple', [[], [dialog, foreign]], False, 'ambiguous_dialogs', 1, 0, 0),
            ('replaced_before_focus', [[], [dialog], [foreign]], False, 'replaced_dialog', 1, 0, 0),
            ('disappeared_then_same_visible', [[], [dialog], [], [], [dialog], [dialog], []], False, 'none', 1, 1, 1),
            ('focus_failure', [[], [dialog], [dialog]], True, 'command_failed', 1, 1, 0),
            ('replaced_during_close', [[], [dialog], [dialog], [foreign]], False, 'replaced_dialog', 1, 1, 1),
        ]
        for name, searches, focus_failure, reason, triggers, focuses, confirmations in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                destination = pathlib.Path(directory) / 'private-destination'
                client = flows.Native.__new__(flows.Native)
                client.profile = 1
                trigger = Mock()
                remaining = iter(searches)
                commands = []

                def run(args, **kwargs):
                    commands.append(args)
                    self.assertTrue(kwargs['capture_output'])
                    if args[1] == 'search':
                        self.assertLessEqual(kwargs['timeout'], 1)
                        values = next(remaining)
                        return subprocess.CompletedProcess(args, 0 if values else 1,
                            ('\n'.join(values) + ('\n' if values else '')).encode(), b'')
                    if args[1] == 'windowfocus' and focus_failure:
                        raise subprocess.CalledProcessError(1, args, stderr=b'private-error-must-not-escape')
                    if args[1:] == ['key', 'Return']:
                        destination.write_bytes(b'completed disposable download')
                    return subprocess.CompletedProcess(args, 0, b'', b'')

                with patch.dict(flows.metadata, {}, clear=True), \
                        patch.object(flows.subprocess, 'run', side_effect=run), \
                        patch.object(flows.time, 'sleep'), patch.object(flows, 'persist'):
                    if reason == 'none':
                        client.save(destination, trigger)
                        self.assertEqual(flows.metadata['save_diagnostic']['phase'], 'complete')
                    else:
                        expected = subprocess.CalledProcessError if focus_failure else RuntimeError
                        with self.assertRaises(expected):
                            client.save(destination, trigger)
                    self.assertEqual(flows.metadata['save_diagnostic']['reason'], reason)
                    serialized = json.dumps(flows.metadata)
                    for private in [dialog, foreign, str(destination), 'private-error-must-not-escape']:
                        self.assertNotIn(private, serialized)
                    if focus_failure:
                        self.assertEqual(flows.metadata['save_diagnostic']['phase'], 'focus')
                        self.assertEqual(flows.metadata['save_diagnostic']['exitcode'], 1)
                self.assertEqual(trigger.call_count, triggers)
                self.assertEqual(sum(args[1] == 'windowfocus' for args in commands), focuses)
                self.assertEqual(sum(args[1:] == ['key', 'Return'] for args in commands), confirmations)
                self.assertEqual(sum(args[1] == 'type' for args in commands), confirmations)
                if focuses:
                    focus_index = next(index for index, args in enumerate(commands) if args[1] == 'windowfocus')
                    self.assertIn('--onlyvisible', commands[focus_index - 1])
                    self.assertEqual(commands[focus_index][-1], dialog)
                self.assertNotIn('--onlyvisible', commands[0])
                self.assertIsNone(next(remaining, None), 'Every expected lifecycle observation must be consumed')

    def test_save_visibility_deadline_is_30_seconds_with_single_trigger_and_no_focus(self):
        client = flows.Native.__new__(flows.Native)
        client.profile = 0
        trigger = Mock()
        clock = [0.0]
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(flows.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'')) as run, \
                patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(flows.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
                patch.object(flows, 'persist'), patch.dict(flows.metadata, {}, clear=True):
            with self.assertRaises(TimeoutError):
                client.save(pathlib.Path(directory) / 'download', trigger)
        trigger.assert_called_once()
        self.assertEqual(clock[0], 30)
        self.assertTrue(all(call.args[0][1] == 'search' for call in run.call_args_list))
        self.assertTrue(all(call.kwargs['timeout'] <= 1 for call in run.call_args_list))
        self.assertEqual(run.call_args_list[-1].kwargs['timeout'], .25)

    def test_save_trigger_or_global_deadline_failure_stops_without_focus_or_input(self):
        for error in [RuntimeError('private-trigger-error'), flows.NativeDeadlineExpired()]:
            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory() as directory:
                client = flows.Native.__new__(flows.Native)
                client.profile = 0
                trigger = Mock(side_effect=error)
                with patch.object(flows.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'')) as run, \
                        patch.object(flows, 'persist'), patch.dict(flows.metadata, {}, clear=True):
                    with self.assertRaises(type(error)):
                        client.save(pathlib.Path(directory) / 'download', trigger)
                    run.assert_called_once()
                    trigger.assert_called_once()
                    self.assertNotIn('private-trigger-error', json.dumps(flows.metadata))

    def test_auth_destination_requires_exact_origin_path_and_protected_content(self):
        for path in ['/app', '/app/messages']:
            for url in [
                flows.ORIGIN + '/sign-in?next=' + path,
                flows.ORIGIN + '/sign-in?next=' + flows.urllib.parse.quote(path, safe=''),
                flows.ORIGIN + '/sign-in#' + path,
                flows.ORIGIN + path + '-other', flows.ORIGIN + path + '/extra',
                'https://outside.example' + path, 'http://localhost:9443' + path,
                'https://localhost:9444' + path,
            ]:
                with self.subTest(path=path, url=url):
                    self.assertFalse(flows.auth_destination_reached({'url': url, 'protected_content': True}, path))
            for protected in [False, None, 1, 'true']:
                self.assertFalse(flows.auth_destination_reached({
                    'url': flows.ORIGIN + path, 'protected_content': protected,
                }, path))
            self.assertTrue(flows.auth_destination_reached({
                'url': flows.ORIGIN + path + '?view=test#section', 'protected_content': True,
            }, path))
        self.assertFalse(flows.at_app_path(flows.ORIGIN + '/app?next=/sign-in', '/sign-in'))
        self.assertTrue(flows.at_app_path(flows.ORIGIN + '/sign-in?next=/app/messages', '/sign-in'))

    def test_login_submits_once_and_waits_for_protected_destination_in_recovery_profile(self):
        client = flows.Native.__new__(flows.Native)
        client.profile = 2
        client.goto, client.fill, client.click = Mock(), Mock(), Mock()
        client.command = Mock(side_effect=[
            {'url': flows.ORIGIN + '/sign-in?next=/app/messages', 'protected_content': False},
            {'url': flows.ORIGIN + '/app/messages', 'protected_content': False},
            {'url': flows.ORIGIN + '/app/messages', 'protected_content': True},
        ])
        with patch.object(flows, 'auth_progress'), patch.object(flows.time, 'sleep'):
            client.login('disposable@example.test')
        client.click.assert_called_once_with('Sign in')
        client.goto.assert_called_once_with('/sign-in?next=/app/messages')
        self.assertEqual(client.command.call_count, 3)
        for call in client.command.call_args_list:
            self.assertEqual(call.args[:2], ('POST', '/execute/sync'))
            self.assertLessEqual(call.kwargs['timeout'], 2)

    def test_signup_submits_once_and_uses_the_same_protected_destination_barrier(self):
        client = flows.Native.__new__(flows.Native)
        client.profile = 0
        client.goto, client.fill, client.click = Mock(), Mock(), Mock()
        client.element = Mock(return_value='checkbox')
        client.command = Mock(side_effect=[None,
            {'url': flows.ORIGIN + '/app', 'protected_content': False},
            {'url': flows.ORIGIN + '/app', 'protected_content': True},
        ])
        with patch.object(flows, 'auth_progress'), patch.object(flows.time, 'sleep'):
            self.assertEqual(client.signup('Native Alice'), 'native-alice@example.test')
        client.click.assert_called_once_with('Create account')
        self.assertEqual(client.command.call_count, 3)
        self.assertEqual(client.command.call_args_list[0].args[:2], ('POST', '/element/checkbox/click'))

    def test_auth_barrier_keeps_30_second_budget_without_replaying_any_action(self):
        client = flows.Native.__new__(flows.Native)
        client.command = Mock(return_value={'url': flows.ORIGIN + '/app/messages', 'protected_content': False})
        clock = [0.0]
        with patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(flows.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            with self.assertRaises(TimeoutError):
                client.wait_authenticated('/app/messages')
        self.assertEqual(clock[0], 30)
        self.assertTrue(all(call.args[:2] == ('POST', '/execute/sync') for call in client.command.call_args_list))
        self.assertEqual(client.command.call_args_list[-1].kwargs['timeout'], .25)

    def test_auth_diagnostic_keeps_only_fixed_counts_status_and_boolean(self):
        private = 'private-value-must-not-be-retained'
        client = types.SimpleNamespace(profile=0, command=Mock(return_value={
            'route': private, 'forms': 1, 'invalid_controls': 0, 'alerts': 1, 'notices': 0,
            'pending': False, 'http_status': 200, 'authenticated': False,
            'user': private, 'session': private, 'url': private, 'headers': private,
        }))
        result = flows.auth_diagnostics(client)
        self.assertEqual(result, {'profile': 0, 'route': 'other', 'forms': 1,
            'invalid_controls': 0, 'alerts': 1, 'notices': 0, 'pending': False,
            'http_status': 200, 'authenticated': False})
        self.assertNotIn(private, json.dumps(result))
        client.command.assert_called_once()
        self.assertEqual(client.command.call_args.args[:2], ('POST', '/execute/async'))
        self.assertEqual(client.command.call_args.kwargs['timeout'], 2)
        self.assertEqual(client.command.call_args.args[2]['args'], [flows.ORIGIN, 1500])

    def test_auth_diagnostic_and_transport_share_existing_failure_budget(self):
        client = types.SimpleNamespace(profile=0)
        clock = [0.0]

        def auth(_client, timeout):
            self.assertEqual(timeout, 2)
            clock[0] += timeout
            return {'http_status': 200, 'authenticated': False}

        with patch.dict(flows.metadata, {'auth_action': {'profile': 0}}, clear=True), \
                patch.dict(flows.results, {'signup_login': {'status': 'failed'}, 'dm_recovery': {'status': 'not-run'}}), \
                patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(flows, 'auth_diagnostics', side_effect=auth) as observation, \
                patch.object(flows, 'transport_diagnostics', return_value={}) as transport:
            flows.failure_diagnostics([client])
            observation.assert_called_once()
            transport.assert_called_once_with([client], budget=8)
            flows.results['signup_login'] = {'status': 'passed'}
            observation.reset_mock()
            flows.failure_diagnostics([client])
            observation.assert_not_called()
            flows.results['signup_login'] = {'status': 'failed'}
            observation.side_effect = flows.NativeDeadlineExpired()
            transport.reset_mock()
            with self.assertRaises(flows.NativeDeadlineExpired):
                flows.failure_diagnostics([client])
            transport.assert_not_called()

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

    def test_startup_only_transient_disconnect_then_false_then_true(self):
        errors = [flows.http.client.RemoteDisconnected('private'), ConnectionRefusedError(),
                  ConnectionResetError(), ConnectionAbortedError(), TimeoutError(),
                  urllib.error.URLError(ConnectionRefusedError())]
        for error in errors:
            with self.subTest(error_type=type(error).__name__):
                client = flows.Native.__new__(flows.Native)
                client.profile = 0
                client.session = None
                client.request = Mock(side_effect=[error, {'ready': False}, {'ready': True}])
                clock = [0.0]
                with patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(flows.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
                    client.wait_startup_ready()
                self.assertEqual(client.request.call_count, 3)
                for call in client.request.call_args_list:
                    self.assertEqual(call.args, ('GET', '/status'))
                    self.assertLessEqual(call.kwargs['timeout'], 1)
                self.assertEqual(flows.metadata['startup_readiness']['0']['state'], 'ready')

    def test_startup_deadline_and_postsession_guard(self):
        client = flows.Native.__new__(flows.Native)
        client.profile = 0
        client.session = None
        client.request = Mock(return_value={'ready': False})
        clock = [0.0]
        with patch.object(flows.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(flows.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            with self.assertRaises(TimeoutError):
                client.wait_startup_ready(timeout=.5)
        self.assertEqual(clock[0], .5)
        self.assertEqual(client.request.call_count, 2)
        client.session = 'existing-private-session'
        client.request.reset_mock()
        with self.assertRaises(RuntimeError):
            client.wait_startup_ready()
        client.request.assert_not_called()

    def test_startup_http_schema_and_other_errors_fail_immediately(self):
        cases = [({'ready': 'yes'}, None, ValueError), ([], None, ValueError),
                 (None, urllib.error.HTTPError('http://127.0.0.1/status', 500, '', {}, io.BytesIO()), urllib.error.HTTPError),
                 (None, urllib.error.URLError(PermissionError()), urllib.error.URLError),
                 (None, flows.http.client.BadStatusLine('private'), flows.http.client.BadStatusLine)]
        for value, error, expected in cases:
            with self.subTest(expected=expected.__name__):
                client = flows.Native.__new__(flows.Native)
                client.profile = 0
                client.session = None
                client.request = Mock(return_value=value, side_effect=error)
                with patch.object(flows.time, 'sleep') as sleep:
                    with self.assertRaises(expected):
                        client.wait_startup_ready()
                client.request.assert_called_once()
                sleep.assert_not_called()

    def test_global_deadline_is_not_wrapped_or_consumed_by_request_and_wait(self):
        self.assertFalse(issubclass(flows.NativeDeadlineExpired, OSError))
        for operation in ['request', 'getresponse']:
            with self.subTest(operation=operation):
                client = flows.Native.__new__(flows.Native)
                client.profile = 0
                client.port = 4444
                client.connection = Mock()
                client.connection.sock = None
                getattr(client.connection, operation).side_effect = lambda *args, **kwargs: flows.deadline(signal.SIGALRM, None)
                with self.assertRaises(flows.NativeDeadlineExpired):
                    flows.wait(lambda: client.request('GET', '/status'))
                client.connection.request.assert_called_once()
                client.connection.close.assert_called_once()

    def test_ordinary_request_network_error_is_sent_once_then_propagates(self):
        client = flows.Native.__new__(flows.Native)
        client.profile = 0
        client.port = 4444
        client.connection = Mock()
        client.connection.sock = None
        client.connection.request.side_effect = ConnectionResetError()
        with self.assertRaises(urllib.error.URLError):
            client.request('POST', '/session/unit/element/unit/click', {})
        client.connection.request.assert_called_once()
        client.connection.getresponse.assert_not_called()
        client.connection.close.assert_called_once()

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
