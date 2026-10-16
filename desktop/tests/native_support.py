"""Small synchronization and cleanup helpers for native acceptance."""
import subprocess
import time


def has_complete_bytes(path, expected, observation=None):
    try:
        actual = path.read_bytes()
    except FileNotFoundError:
        actual = None
    complete = actual == expected
    if observation is not None:
        observation.clear()
        observation.update(expected_length=len(expected), observed_length=len(actual) if actual is not None else 0)
        if not complete:
            observation['classification'] = ('missing' if actual is None else 'empty' if not actual
                else 'length_mismatch' if len(actual) != len(expected) else 'same_length_content_mismatch')
    return complete


def native_save_dialog(destination, trigger, wait_for, diagnostic, *, cancel=False, also_absent=()):
    """One causal native Save interaction; returned read-only check proves dialog close."""
    diagnostic.update(phase='preflight', reason='none', visible_count=0, visibility_checks=0,
                      disappeared_count=0)
    candidate = None
    deadline_at = None

    def reject(reason):
        diagnostic['reason'] = reason
        raise RuntimeError('Native Save dialog invariant failed') from None

    def bounded(limit):
        if deadline_at is None:
            return limit
        remaining = deadline_at - time.monotonic()
        if remaining <= 0:
            reject('dialog_deadline')
        return min(limit, remaining)

    def windows(visible=False):
        args = ['xdotool', 'search'] + (['--onlyvisible'] if visible else [])
        try:
            found = subprocess.run(args + ['--name', '^Save OpenDiscord download$'],
                                   capture_output=True, check=False, timeout=bounded(1))
            if found.returncode == 1 and not found.stdout and not found.stderr:
                if visible:
                    diagnostic['visible_count'] = 0
                    diagnostic['visibility_checks'] += 1
                return []
            if found.returncode != 0:
                reject('search_failed')
            identifiers = found.stdout.decode('ascii').splitlines()
            if any(not value.isdecimal() or int(value) <= 0 for value in identifiers):
                reject('invalid_window_reference')
            if visible:
                diagnostic['visible_count'] = len(identifiers)
                diagnostic['visibility_checks'] += 1
            return identifiers
        except subprocess.TimeoutExpired:
            reject('command_timeout')
        except UnicodeError:
            reject('invalid_window_reference')

    def absent():
        if any(path.exists() for path in (destination, *also_absent)):
            reject('destination_before_consent')

    def ready():
        nonlocal candidate
        matches = windows(visible=True)
        if len(matches) > 1:
            reject('ambiguous_dialogs')
        if not matches:
            return False
        if candidate is not None and candidate != matches[0]:
            reject('replaced_dialog')
        candidate = matches[0]
        # Revalidate the same visible window immediately before the sole focus operation.
        current = windows(visible=True)
        if len(current) > 1:
            reject('ambiguous_dialogs')
        if current and current[0] != candidate:
            reject('replaced_dialog')
        if not current:
            diagnostic['disappeared_count'] += 1
            return False
        diagnostic['phase'] = 'focus'
        subprocess.run(['xdotool', 'windowfocus', '--sync', candidate],
                       capture_output=True, check=True, timeout=bounded(5))
        return True

    def closed():
        diagnostic['phase'] = 'await_closed'
        current = windows()
        if any(identifier != candidate for identifier in current):
            reject('replaced_dialog')
        diagnostic['closed'] = not current
        return not current

    try:
        if windows():
            reject('preexisting_dialog')
        absent()
        diagnostic['phase'] = 'trigger'
        trigger()
        deadline_at = time.monotonic() + 30
        diagnostic['phase'] = 'await_visible_dialog'
        wait_for(ready, 'Native Save dialog readiness deadline exceeded')
        absent()
        if not cancel:
            diagnostic['phase'] = 'select_destination'
            subprocess.run(['xdotool', 'key', 'ctrl+a'], capture_output=True, check=True, timeout=bounded(5))
            diagnostic['phase'] = 'type_destination'
            subprocess.run(['xdotool', 'type', '--clearmodifiers', str(destination)],
                           capture_output=True, check=True, timeout=bounded(5))
        # Cancel the untouched chooser; path completion can consume Escape after typing.
        absent()
        diagnostic['phase'] = 'cancel' if cancel else 'confirm'
        subprocess.run(['xdotool', 'key', 'Escape' if cancel else 'Return'],
                       capture_output=True, check=True, timeout=bounded(5))
        # Completion shares the existing post-confirm 60 x 0.5s window, including close checks.
        deadline_at = time.monotonic() + 30
        return closed
    except subprocess.CalledProcessError:
        reject('command_failed')
    except subprocess.TimeoutExpired:
        reject('command_timeout')
    except AssertionError:
        reject('readiness_deadline')
    except Exception:
        if diagnostic['reason'] == 'none':
            diagnostic['reason'] = 'interaction_failed'
        raise RuntimeError('Native Save interaction failed') from None


def cleanup(delete_session, driver, server, log, primary_error, remove_sandbox=None):
    errors = []
    for action in (delete_session, driver.terminate):
        try:
            action()
        except Exception as error:
            errors.append(error)
    try:
        driver.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            driver.kill()
            driver.wait(timeout=5)
        except Exception as error:
            errors.append(error)
    except Exception as error:
        errors.append(error)
    for action in (server.shutdown, server.server_close, log.close, remove_sandbox):
        if action is None:
            continue
        try:
            action()
        except Exception as error:
            errors.append(error)
    if errors:
        if primary_error is None:
            raise ExceptionGroup('Native acceptance cleanup failed', errors)
        primary_error.add_note('Native cleanup also failed: ' + '; '.join(map(str, errors)))
