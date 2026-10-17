import pathlib
import json
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from native_support import cleanup, has_complete_bytes, native_save_dialog


class NativeSupportTests(unittest.TestCase):
    def test_waits_for_complete_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'download'
            self.assertFalse(has_complete_bytes(path, b'complete'))
            path.write_bytes(b'com')
            self.assertFalse(has_complete_bytes(path, b'complete'))
            path.write_bytes(b'complete')
            self.assertTrue(has_complete_bytes(path, b'complete'))

    def test_download_failure_classification_retains_only_lengths_and_fixed_categories(self):
        expected = b'private fixture'
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'private-path'
            observation = {}
            cases = [(None, 'missing', 0), (b'', 'empty', 0), (b'priv', 'length_mismatch', 4),
                     (b'PRIVATE fixture', 'same_length_content_mismatch', len(expected)), (expected, None, len(expected))]
            for contents, classification, length in cases:
                with self.subTest(classification=classification):
                    if contents is not None:
                        path.write_bytes(contents)
                    self.assertEqual(has_complete_bytes(path, expected, observation), classification is None)
                    self.assertEqual(observation.get('classification'), classification)
                    self.assertEqual(observation['expected_length'], len(expected))
                    self.assertEqual(observation['observed_length'], length)
                    self.assertNotIn('private', json.dumps(observation))

    def test_save_waits_for_visible_unique_revalidated_dialog_then_focuses_and_inputs_once(self):
        for cancel in [False, True]:
            with self.subTest(cancel=cancel), tempfile.TemporaryDirectory() as directory:
                destination = pathlib.Path(directory) / 'private-target'
                diagnostic, commands = {}, []
                searches = [[], [], ['73123'], [], ['73123'], ['73123'], ['73123'], []]
                trigger = Mock()

                def run(args, **kwargs):
                    commands.append(args)
                    self.assertTrue(kwargs['capture_output'])
                    self.assertLessEqual(kwargs['timeout'], 5)
                    if args[1] == 'search':
                        self.assertEqual(args[-1], '^Save OpenDiscord download$')
                        found = searches.pop(0)
                        return subprocess.CompletedProcess(args, 0 if found else 1,
                            ('\n'.join(found) + ('\n' if found else '')).encode(), b'')
                    trigger.assert_called_once()
                    if args[1] in {'key', 'type'}:
                        self.assertTrue(any(command[1] == 'windowfocus' for command in commands))
                    return subprocess.CompletedProcess(args, 0, b'', b'')

                def wait_for(check, _message):
                    for _ in range(60):
                        if check():
                            return
                    raise AssertionError('deadline')

                with patch('native_support.subprocess.run', side_effect=run):
                    closed = native_save_dialog(destination, trigger, wait_for, diagnostic, cancel=cancel)
                    self.assertFalse(closed())
                    self.assertTrue(closed())
                trigger.assert_called_once()
                self.assertNotIn('--onlyvisible', commands[0])
                self.assertTrue(all('--onlyvisible' in command for command in commands[1:6]))
                self.assertEqual(sum(command[1] == 'windowfocus' for command in commands), 1)
                self.assertEqual([command for command in commands if command[1] == 'type'],
                                 [] if cancel else [['xdotool', 'type', '--clearmodifiers', str(destination)]])
                self.assertEqual([command for command in commands if command[1] == 'key'],
                                 [['xdotool', 'key', 'Escape']] if cancel else
                                 [['xdotool', 'key', 'ctrl+a'], ['xdotool', 'key', 'Return']])
                self.assertNotIn('73123', json.dumps(diagnostic))
                self.assertNotIn('private-target', json.dumps(diagnostic))

    def test_save_rejects_preexisting_ambiguous_replaced_or_unfocused_dialog_without_inputs(self):
        cases = [('preexisting_dialog', [['73123']], False, 0),
                 ('ambiguous_dialogs', [[], ['73123', '83123']], False, 1),
                 ('replaced_dialog', [[], ['73123'], ['83123']], False, 1),
                 ('command_failed', [[], ['73123'], ['73123']], True, 1)]
        for reason, searches, focus_failure, triggers in cases:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                trigger, diagnostic, commands = Mock(), {}, []

                def run(args, **kwargs):
                    commands.append(args)
                    if args[1] == 'search':
                        found = searches.pop(0)
                        return subprocess.CompletedProcess(args, 0 if found else 1,
                            '\n'.join(found).encode(), b'')
                    if focus_failure:
                        raise subprocess.CalledProcessError(1, args, stderr=b'private-error')
                    self.fail('Unexpected native input')

                with patch('native_support.subprocess.run', side_effect=run):
                    with self.assertRaises(RuntimeError) as error:
                        native_save_dialog(pathlib.Path(directory) / 'private-target', trigger,
                                           lambda check, message: check(), diagnostic)
                self.assertEqual(diagnostic['reason'], reason)
                self.assertEqual(trigger.call_count, triggers)
                self.assertFalse(any(command[1] in {'key', 'type'} for command in commands))
                self.assertNotIn('private', str(error.exception))
                self.assertNotIn('83123', json.dumps(diagnostic))
                self.assertTrue(error.exception.__suppress_context__)

    def test_cancel_rejects_default_destination_before_trigger(self):
        with tempfile.TemporaryDirectory() as directory:
            destination, default = pathlib.Path(directory) / 'chosen', pathlib.Path(directory) / 'default'
            default.write_bytes(b'private')
            trigger, diagnostic = Mock(), {}
            with patch('native_support.subprocess.run', return_value=subprocess.CompletedProcess([], 1, b'', b'')):
                with self.assertRaises(RuntimeError):
                    native_save_dialog(destination, trigger, Mock(), diagnostic, cancel=True, also_absent=(default,))
            trigger.assert_not_called()
            self.assertEqual(diagnostic['reason'], 'destination_before_consent')

    def test_save_checks_consent_before_trigger_and_again_before_confirming(self):
        for phase in ['baseline', 'trigger', 'type']:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                destination = pathlib.Path(directory) / 'private-target'
                diagnostic, commands = {}, []
                if phase == 'baseline':
                    destination.write_bytes(b'private')

                def trigger():
                    if phase == 'trigger':
                        destination.write_bytes(b'private')

                def run(args, **kwargs):
                    commands.append(args)
                    if args[1] == 'search':
                        visible = '--onlyvisible' in args
                        return subprocess.CompletedProcess(args, 0 if visible else 1, b'73123' if visible else b'', b'')
                    if args[1] == 'type':
                        destination.write_bytes(b'private')
                    return subprocess.CompletedProcess(args, 0, b'', b'')

                with patch('native_support.subprocess.run', side_effect=run):
                    with self.assertRaises(RuntimeError):
                        native_save_dialog(destination, trigger, lambda check, message: check(), diagnostic)
                self.assertEqual(diagnostic['reason'], 'destination_before_consent')
                self.assertFalse(any(command[-1] in {'Return', 'Escape'} for command in commands))

    def test_save_readiness_deadline_does_not_retrigger_focus_or_type(self):
        diagnostic, trigger = {}, Mock()
        empty = subprocess.CompletedProcess([], 1, b'', b'')

        def wait_for(check, _message):
            for _ in range(60):
                self.assertFalse(check())
            raise AssertionError('deadline')

        with tempfile.TemporaryDirectory() as directory, \
                patch('native_support.subprocess.run', return_value=empty) as run:
            with self.assertRaises(RuntimeError):
                native_save_dialog(pathlib.Path(directory) / 'target', trigger, wait_for, diagnostic)
        trigger.assert_called_once()
        self.assertEqual(run.call_count, 61)
        self.assertTrue(all(call.args[0][1] == 'search' for call in run.call_args_list))
        self.assertEqual(diagnostic['reason'], 'readiness_deadline')

    def test_save_closed_check_rejects_replacement_and_does_not_repeat_confirmation(self):
        searches = [[], ['73123'], ['73123'], ['83123']]
        diagnostic, commands = {}, []

        def run(args, **kwargs):
            commands.append(args)
            if args[1] == 'search':
                found = searches.pop(0)
                return subprocess.CompletedProcess(args, 0 if found else 1, '\n'.join(found).encode(), b'')
            return subprocess.CompletedProcess(args, 0, b'', b'')

        with tempfile.TemporaryDirectory() as directory, patch('native_support.subprocess.run', side_effect=run):
            closed = native_save_dialog(pathlib.Path(directory) / 'target', Mock(),
                                        lambda check, message: check(), diagnostic)
            with self.assertRaises(RuntimeError):
                closed()
        self.assertEqual(diagnostic['reason'], 'replaced_dialog')
        self.assertEqual(sum(command[-1] == 'Return' for command in commands), 1)

    def test_save_close_observation_uses_original_thirty_second_completion_budget(self):
        searches = [[], ['73123'], ['73123']]
        diagnostic, commands, clock = {}, [], [0.0]

        def run(args, **kwargs):
            commands.append(args)
            if args[1] == 'search':
                found = searches.pop(0)
                return subprocess.CompletedProcess(args, 0 if found else 1, '\n'.join(found).encode(), b'')
            return subprocess.CompletedProcess(args, 0, b'', b'')

        with tempfile.TemporaryDirectory() as directory, \
                patch('native_support.subprocess.run', side_effect=run), \
                patch('native_support.time.monotonic', side_effect=lambda: clock[0]):
            closed = native_save_dialog(pathlib.Path(directory) / 'target', Mock(),
                                        lambda check, message: check(), diagnostic)
            count = len(commands)
            clock[0] = 30.01
            with self.assertRaises(RuntimeError):
                closed()
        self.assertEqual(len(commands), count)
        self.assertEqual(diagnostic['reason'], 'dialog_deadline')

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
