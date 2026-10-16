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
from unittest.mock import Mock, patch
from contextlib import contextmanager

import native_app_flows as flows


class NativeSupportTests(unittest.TestCase):
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
