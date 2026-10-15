"""Small synchronization and cleanup helpers for native acceptance."""
import subprocess


def has_complete_bytes(path, expected):
    try:
        return path.read_bytes() == expected
    except FileNotFoundError:
        return False


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
