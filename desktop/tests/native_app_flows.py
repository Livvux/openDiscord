"""Real Linux Tauri/WebKit acceptance against the isolated production HTTPS app.

No browser replacement, native grants, crypto mocks or test application pages.
Artifacts intentionally contain only step outcomes and sanitized platform metadata.
"""
import base64
import hashlib
import http.client
import io
import json
import os
import pathlib
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid
from contextlib import contextmanager

ORIGIN = 'https://localhost:9443'
ELEMENT = 'element-6066-11e4-a52e-4f735466cecf'
ROOT = pathlib.Path(__file__).resolve().parents[1]
PROC_ROOT = pathlib.Path('/proc')
EVIDENCE = ROOT / 'native-app-evidence'
EVIDENCE.mkdir(exist_ok=True)
CASES = ['native_profile_capabilities', 'signup_login', 'community_navigation',
         'private_attachment', 'community_export', 'dm_enrollment', 'dm_sas_delivery',
         'dm_persistence', 'dm_gateway_recovery', 'dm_recovery', 'logout', 'runtime_errors']
results = {name: {'status': 'not-run'} for name in CASES}
metadata = {'sha': os.environ.get('GITHUB_SHA'), 'scope': 'Linux native production app only',
            'console_capture': 'WebDriver console endpoint probed; absence reported explicitly'}


class NativeDeadlineExpired(Exception):
    """Global expiry must never be mistaken for a retryable socket OSError."""


class OwnedGateway:
    """One workflow-owned Node child; signals always use its retained Linux pidfd."""
    def __init__(self, *, expected_start=None, allow_stopped=False):
        self.fd = None
        self.resume_required = False
        metadata['gateway_recovery'] = {'ownership_valid': False}
        try:
            values = [os.environ.get(key, '') for key in
                      ['NATIVE_APP_PROXY_PID', 'NATIVE_APP_LAUNCHER_PID']]
            if any(not value.isascii() or not value.isdecimal() or int(value) <= 1 for value in values):
                raise ValueError('Missing owned gateway identity')
            self.pid, self.launcher = map(int, values)
            if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
                raise RuntimeError('Linux pidfd signaling unavailable')
            self.fd = os.pidfd_open(self.pid, 0)
            record = self._record()
            self.start = record[19]
            if expected_start is not None and self.start != expected_start:
                raise ValueError('Owned gateway start identity mismatch')
            directory = PROC_ROOT / str(self.pid)
            node = shutil.which('node')
            if (record[0] in {'Z', 'X'} or (not allow_stopped and record[0] in {'T', 't'})
                    or int(record[1]) != self.launcher
                    or int(record[2]) != self.pid or int(record[3]) != self.pid
                    or node is None or directory.joinpath('exe').resolve() != pathlib.Path(node).resolve()
                    or directory.joinpath('cwd').resolve() != ROOT.parent
                    or directory.joinpath('cmdline').read_bytes().split(b'\0') !=
                        [b'node', b'desktop/tests/app_proxy.mjs', b'']):
                raise ValueError('Owned gateway identity mismatch')
            uid = next(line.split()[1:] for line in directory.joinpath('status').read_text().splitlines()
                       if line.startswith('Uid:'))
            if uid != [str(os.getuid())] * 4:
                raise ValueError('Owned gateway UID mismatch')
            self.stopped()  # Recheck the start identity after all private metadata reads.
            metadata['gateway_recovery']['ownership_valid'] = True
        except BaseException:
            self.close()
            raise

    def _record(self):
        value = (PROC_ROOT / str(self.pid) / 'stat').read_text()
        if int(value.split(' ', 1)[0]) != self.pid:
            raise ValueError('Owned gateway record mismatch')
        fields = value.rsplit(') ', 1)[1].split()
        if len(fields) < 20:
            raise ValueError('Incomplete owned gateway record')
        return fields

    def stopped(self):
        record = self._record()
        if record[19] != self.start or int(record[1]) != self.launcher or record[0] in {'Z', 'X'}:
            raise ValueError('Owned gateway identity changed')
        return record[0] in {'T', 't'}

    def await_state(self, stopped):
        end = time.monotonic() + 1
        while True:
            if self.stopped() is stopped:
                return
            if time.monotonic() >= end:
                raise TimeoutError('Owned gateway state deadline exceeded')
            time.sleep(.01)

    def resume(self):
        if self.resume_required:
            signal.pidfd_send_signal(self.fd, signal.SIGCONT, None, 0)
            self.await_state(False)
            self.resume_required = False
            metadata['gateway_recovery']['resumed'] = True

    @contextmanager
    def paused(self):
        if self.stopped():
            raise ValueError('Owned gateway already stopped')
        previous = signal.getitimer(signal.ITIMER_REAL)
        if previous[0] <= 0:
            raise RuntimeError('Global native deadline is required')
        started = time.monotonic()
        handler = signal.signal(signal.SIGALRM, deadline)
        try:
            signal.setitimer(signal.ITIMER_REAL, min(8, previous[0]))
            # Set the obligation first: Python can be interrupted after STOP was applied.
            self.resume_required = True
            signal.pidfd_send_signal(self.fd, signal.SIGSTOP, None, 0)
            self.await_state(True)
            metadata['gateway_recovery']['stopped_confirmed'] = True
            yield
        finally:
            # Resume precedes any diagnostics, even when a catchable signal interrupted a command.
            blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM, signal.SIGTERM, signal.SIGINT})
            signal.setitimer(signal.ITIMER_REAL, 0)
            try:
                self.resume()
            finally:
                elapsed = time.monotonic() - started
                metadata['gateway_recovery']['paused_seconds'] = round(elapsed, 3)
                signal.signal(signal.SIGALRM, handler)
                signal.setitimer(signal.ITIMER_REAL, max(.001, previous[0] - elapsed), previous[1])
                signal.pthread_sigmask(signal.SIG_SETMASK, blocked)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def resume_owned_gateway():
    """Synchronous shell fallback: validate first, resume only the opened descriptor."""
    gateway = None
    try:
        expected = os.environ.get('NATIVE_APP_PROXY_START', '')
        if not expected.isascii() or not expected.isdecimal() or int(expected) <= 0:
            return False
        gateway = OwnedGateway(expected_start=expected, allow_stopped=True)
        gateway.resume_required = True
        gateway.resume()
        return True
    except Exception:
        # Cleanup does not expose process identity, arguments or private exception bodies.
        return False
    finally:
        if gateway is not None:
            gateway.close()


def persist():
    (EVIDENCE / 'results.json').write_text(json.dumps({'steps': results, 'metadata': metadata}, indent=2))


@contextmanager
def stage(name):
    started = time.monotonic()
    try:
        yield
    except BaseException as error:
        # Exception bodies may contain DOM, recovery files or driver response data.
        results[name] = {'status': 'failed', 'error_type': type(error).__name__,
                         'seconds': round(time.monotonic() - started, 2)}
        persist()
        raise RuntimeError('Native acceptance failed at ' + name) from None
    else:
        status = results[name].get('status')
        results[name] = {**results[name], 'status': status if status == 'unavailable' else 'passed',
                         'seconds': round(time.monotonic() - started, 2)}
        persist()


def wait(check, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (urllib.error.URLError, KeyError):
            pass
        time.sleep(.25)
    raise TimeoutError('Condition deadline exceeded')


class Native:
    def __init__(self, index, sandbox):
        self.profile = index
        self.port = 4444 + index * 2
        self.session = None
        self.connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=40)
        self.home = sandbox / str(index)
        for directory in ['Downloads', '.config', '.local/share', '.cache']:
            (self.home / directory).mkdir(parents=True, exist_ok=True)
        (self.home / '.config/user-dirs.dirs').write_text('XDG_DOWNLOAD_DIR="$HOME/Downloads"\n')
        self.log = tempfile.TemporaryFile()
        self.process = subprocess.Popen(['tauri-driver', '--port', str(self.port), '--native-port', str(self.port + 1)],
            stdout=self.log, stderr=self.log, start_new_session=True,
            env={**os.environ, 'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.home / '.config'),
                 'XDG_DATA_HOME': str(self.home / '.local/share'), 'XDG_CACHE_HOME': str(self.home / '.cache')})

    def request(self, method, path, body=None, *, timeout=40):
        metadata['last_native_request'] = {
            'profile': self.profile, 'method': method, 'endpoint': endpoint_class(path),
        }
        try:
            encoded = json.dumps(body).encode() if body is not None else None
            self.connection.timeout = timeout
            if self.connection.sock is not None:
                self.connection.sock.settimeout(timeout)
            try:
                self.connection.request(method, path, body=encoded, headers={'Content-Type': 'application/json'})
            except OSError as error:
                # Match urllib's existing request/connect-error classification for readiness.
                raise urllib.error.URLError(error) from None
            with self.connection.getresponse() as response:
                payload = response.read()
                if not 200 <= response.status < 300:
                    raise urllib.error.HTTPError(f'http://127.0.0.1:{self.port}' + path,
                        response.status, 'Native WebDriver request failed', response.headers, io.BytesIO(payload))
                return json.loads(payload)['value']
        except BaseException:
            # No replay: discard this connection and propagate the first command failure.
            self.connection.close()
            raise

    def wait_startup_ready(self, timeout=30):
        if self.session is not None:
            raise RuntimeError('Startup readiness is only valid before a session')
        deadline_at = time.monotonic() + timeout
        attempts = 0
        while True:
            remaining = deadline_at - time.monotonic()
            if remaining <= 0:
                break
            attempts += 1
            state = {'attempts': attempts, 'state': 'checking'}
            metadata.setdefault('startup_readiness', {})[str(self.profile)] = state
            try:
                value = self.request('GET', '/status', timeout=min(1, remaining))
            except urllib.error.HTTPError:
                raise
            except urllib.error.URLError as error:
                if not isinstance(error.reason, (ConnectionRefusedError, ConnectionResetError,
                                                  ConnectionAbortedError, TimeoutError)):
                    raise
                state.update(state='transient_network_error', error_type=type(error.reason).__name__)
            except (http.client.RemoteDisconnected, ConnectionRefusedError, ConnectionResetError,
                    ConnectionAbortedError, TimeoutError) as error:
                state.update(state='transient_network_error', error_type=type(error).__name__)
            else:
                if not isinstance(value, dict) or not isinstance(value.get('ready'), bool):
                    raise ValueError('Invalid native driver startup status')
                if value['ready'] is True:
                    state['state'] = 'ready'
                    return
                state['state'] = 'not_ready'
            remaining = deadline_at - time.monotonic()
            if remaining > 0:
                time.sleep(min(.25, remaining))
        raise TimeoutError('Native driver startup readiness deadline exceeded')

    def start(self):
        self.wait_startup_ready()
        value = self.request('POST', '/session', {'capabilities': {'alwaysMatch': {
            'tauri:options': {'application': str(ROOT / 'target/debug/opendiscord-desktop')}}}})
        self.session = value['sessionId']
        self.command('POST', '/timeouts', {'script': 60000, 'pageLoad': 60000, 'implicit': 0})
        self.command('POST', '/url', {'url': ORIGIN + '/sign-in'})
        if self.profile == 0:
            metadata['preauth_transport_contract'] = transport_contract(self)
            persist()
        wait(lambda: self.script('return document.readyState') == 'complete')

    def command(self, method, path, body=None, *, timeout=40):
        return self.request(method, '/session/' + self.session + path, body, timeout=timeout)

    def script(self, script, *args):
        return self.command('POST', '/execute/sync', {'script': script, 'args': list(args)})

    def async_script(self, script, *args):
        return self.command('POST', '/execute/async', {'script': script, 'args': list(args)})

    def goto(self, path):
        self.command('POST', '/url', {'url': ORIGIN + path})
        wait(lambda: self.script('return document.readyState') == 'complete')

    def element(self, xpath):
        def find():
            values = self.command('POST', '/elements', {'using': 'xpath', 'value': xpath})
            for item in values:
                identifier = item[ELEMENT]
                if self.command('GET', '/element/' + identifier + '/displayed'):
                    return identifier
            return None
        return wait(find)

    def click(self, text, tag='button'):
        identifier = self.element(f'//{tag}[normalize-space(.)={json.dumps(text)} or @aria-label={json.dumps(text)}]')
        wait(lambda: self.command('GET', '/element/' + identifier + '/enabled'))
        self.command('POST', '/element/' + identifier + '/click', {})

    def finish_sign_out(self):
        # The only encrypted-messaging device without a recovery backup asks first (dm-sign-out.tsx).
        def state():
            if at_app_path(self.command('GET', '/url'), '/sign-in'):
                return 'signed-out'
            for item in self.command('POST', '/elements', {'using': 'xpath', 'value': '//button[normalize-space(.)="Sign out anyway"]'}):
                if self.command('GET', '/element/' + item[ELEMENT] + '/displayed'):
                    return item[ELEMENT]
            return None
        found = wait(state)
        if found != 'signed-out':
            self.command('POST', '/element/' + found + '/click', {})
        wait(lambda: at_app_path(self.command('GET', '/url'), '/sign-in'))

    def prefix_click(self, prefix):
        identifier = self.element(f'//button[starts-with(normalize-space(.),{json.dumps(prefix)})]')
        wait(lambda: self.command('GET', '/element/' + identifier + '/enabled'))
        self.command('POST', '/element/' + identifier + '/click', {})

    def open_conversation(self, peer):
        # The Home sidebar lists conversations as links; the peer name has its own marked span.
        identifier = self.element(f'//nav[@aria-label="Home"]//a[.//*[@data-dm-peer-name and normalize-space(.)={json.dumps(peer)}]]')
        self.command('POST', '/element/' + identifier + '/click', {})

    def wait_sent_community_message(self):
        def committed():
            values = self.command('POST', '/elements', {'using': 'xpath', 'value': DM_MESSAGE_XPATH})
            if len(values) > 1:
                raise ValueError('Ambiguous sent community message')
            if not values:
                return None
            element = values[0][ELEMENT]
            identifier = self.command('GET', '/element/' + element + '/attribute/data-message-id')
            # PendingItem has no data-message-id; only a persisted MessageItem qualifies.
            identifier = str(uuid.UUID(identifier))
            return identifier if self.command('GET', '/element/' + element + '/displayed') else None
        return wait(committed)

    def wait_channel(self, path):
        deadline_at = time.monotonic() + 30
        while (remaining := deadline_at - time.monotonic()) > 0:
            snapshot = self.command('POST', '/execute/sync', {'args': [DM_COMPOSER_XPATH], 'script': """
              const visible = node => !!(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
              const composers = document.evaluate(arguments[0], document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              let composerCount = 0;
              for (let i = 0; i < composers.snapshotLength; i++) if (visible(composers.snapshotItem(i))) composerCount++;
              return {url: location.href, composer_count: composerCount,
                channel_log_count: Array.from(document.querySelectorAll('[role="log"][aria-label^="Messages in #"]')).filter(visible).length};
            """}, timeout=min(2, remaining))
            if channel_destination_reached(snapshot, path):
                return
            remaining = deadline_at - time.monotonic()
            if remaining > 0:
                time.sleep(min(.25, remaining))
        raise TimeoutError('Channel destination deadline exceeded')

    def wait_dm_send_complete(self, message):
        deadline_at = time.monotonic() + 30
        while (remaining := deadline_at - time.monotonic()) > 0:
            state = dm_delivery_state(self, message, timeout=min(2, remaining))
            if (all(state.get(key) is True for key in [
                    'at_messages', 'log_visible', 'own_plaintext_present', 'draft_empty', 'textarea_enabled'])
                    and all(state.get(key) == 1 for key in [
                        'selection_count', 'target_selection_count', 'private_log_count', 'textarea_count'])
                    and state.get('alert_count') == 0 and state.get('decrypt_error_count') == 0):
                return
            remaining = deadline_at - time.monotonic()
            if remaining > 0:
                time.sleep(min(.25, remaining))
        raise TimeoutError('Encrypted sender completion deadline exceeded')

    def open_private_message(self, message_id):
        def unique(path, xpath):
            def find():
                values = self.command('POST', path, {'using': 'xpath', 'value': xpath})
                if len(values) > 1:
                    raise ValueError('Ambiguous private-message target')
                return values[0][ELEMENT] if values else None
            return wait(find)

        dm_progress(self.profile, 'locate_community_message')
        message_id = str(uuid.UUID(message_id))
        message = unique('/elements', DM_MESSAGE_XPATH + f'[@data-message-id="{message_id}"]')
        wait(lambda: self.command('GET', '/element/' + message + '/displayed'))
        dm_progress(self.profile, 'hover_community_message')
        # WebKitGTK resolves this element origin into a real mouse move.
        try:
            self.command('POST', '/actions', {'actions': [{
                'type': 'pointer', 'id': 'dm-mouse', 'parameters': {'pointerType': 'mouse'},
                'actions': [{'type': 'pointerMove', 'origin': {ELEMENT: message},
                             'x': 0, 'y': 0, 'duration': 0}],
            }]})
        except urllib.error.HTTPError as error:
            if unsupported_command(error):
                metadata['dm_pointer_capability'] = 'unsupported'
            raise
        metadata['dm_pointer_capability'] = 'supported'
        dm_progress(self.profile, 'locate_private_message_link')
        link = unique('/element/' + message + '/elements', DM_LINK_XPATH)
        dm_progress(self.profile, 'await_private_message_link_visible')
        wait(lambda: self.command('GET', '/element/' + link + '/displayed'))
        dm_progress(self.profile, 'await_private_message_link_enabled')
        wait(lambda: self.command('GET', '/element/' + link + '/enabled'))
        dm_progress(self.profile, 'click_private_message_link')
        self.command('POST', '/element/' + link + '/click', {})

    def fill(self, label, value):
        identifier = self.element(f'//*[self::input or self::textarea][@id=//label[normalize-space(.)={json.dumps(label)}]/@for]'
            f' | //label[starts-with(normalize-space(.),{json.dumps(label)})]//input'
            f' | //textarea[@aria-label={json.dumps(label)}]')
        wait(lambda: self.command('GET', '/element/' + identifier + '/enabled'))
        self.command('POST', '/element/' + identifier + '/value', {'text': value})

    def text(self, text):
        return self.script('return document.body.innerText.includes(arguments[0])', text)

    def screenshot(self, name, *, timeout=40):
        (EVIDENCE / (name + '.png')).write_bytes(base64.b64decode(self.command('GET', '/screenshot', timeout=timeout)))

    def wait_authenticated(self, path):
        deadline_at = time.monotonic() + 30
        while (remaining := deadline_at - time.monotonic()) > 0:
            # URL and protected content must belong to the same document observation.
            snapshot = self.command('POST', '/execute/sync', {'args': [path], 'script': """
              const visible = node => !!(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
              const heading = arguments[0] === '/app' ? 'Friends' : 'Private messages';
              const protectedContent = Array.from(document.querySelectorAll('main h1')).some(node => visible(node) && node.textContent.trim() === heading);
              return {url: location.href, protected_content: protectedContent};
            """}, timeout=min(2, remaining))
            if auth_destination_reached(snapshot, path):
                return
            remaining = deadline_at - time.monotonic()
            if remaining > 0:
                time.sleep(min(.25, remaining))
        raise TimeoutError('Authenticated destination deadline exceeded')

    def signup(self, name):
        email = name.lower().replace(' ', '-') + '@example.test'
        auth_progress(self.profile, 'open_signup')
        self.goto('/sign-up')
        auth_progress(self.profile, 'fill_display_name')
        self.fill('Display name', name)
        auth_progress(self.profile, 'fill_signup_email')
        self.fill('Email', email)
        auth_progress(self.profile, 'fill_signup_password')
        self.fill('Password', 'native acceptance disposable password')
        auth_progress(self.profile, 'confirm_registration_policy')
        checkbox = self.element('//button[@role="checkbox"] | //input[@type="checkbox"]')
        self.command('POST', '/element/' + checkbox + '/click', {})
        auth_progress(self.profile, 'submit_signup')
        self.click('Create account')
        auth_progress(self.profile, 'await_signup_navigation')
        self.wait_authenticated('/app')
        return email

    def login(self, email):
        auth_progress(self.profile, 'open_login')
        self.goto('/sign-in?next=/app/messages')
        auth_progress(self.profile, 'fill_login_email')
        self.fill('Email', email)
        auth_progress(self.profile, 'fill_login_password')
        self.fill('Password', 'native acceptance disposable password')
        auth_progress(self.profile, 'submit_login')
        self.click('Sign in')
        auth_progress(self.profile, 'await_login_navigation')
        self.wait_authenticated('/app/messages')
        # The inbox shell mounts before its persistent crypto bootstrap finishes.
        auth_progress(self.profile, 'await_encryption_ready')
        wait(lambda: self.text('Encrypted messaging ready.'), 60)

    def upload(self, xpath, path):
        identifier = self.element(xpath)
        wait(lambda: self.command('GET', '/element/' + identifier + '/enabled'))
        self.command('POST', '/element/' + identifier + '/value', {'text': str(path)})

    def save(self, destination, trigger):
        state = {'profile': self.profile, 'phase': 'preflight', 'reason': 'none',
                 'visible_count': 0, 'visibility_checks': 0, 'disappeared_count': 0}
        metadata['save_diagnostic'] = state

        def reject(reason):
            state['reason'] = reason
            raise RuntimeError('Native Save dialog invariant failed')

        def windows(visible=False, timeout=1):
            args = ['xdotool', 'search'] + (['--onlyvisible'] if visible else [])
            found = subprocess.run(args + ['--name', '^Save OpenDiscord download$'],
                                   capture_output=True, check=False, timeout=timeout)
            if found.returncode == 1 and not found.stdout and not found.stderr:
                return []
            if found.returncode != 0:
                state['exitcode'] = found.returncode
                reject('search_failed')
            identifiers = found.stdout.decode('ascii').splitlines()
            if any(not value.isdecimal() or int(value) <= 0 for value in identifiers):
                reject('invalid_window_reference')
            return identifiers

        try:
            # This dedicated Xvfb display contains only our three idle/serial profiles.
            # A clean baseline and one UI trigger identify this dialog even with a portal.
            if windows():
                reject('preexisting_dialog')
            assert not destination.exists()
            state['phase'] = 'trigger'
            trigger()
            state['phase'] = 'await_visible_dialog'
            deadline_at = time.monotonic() + 30
            candidate = None
            while True:
                remaining = deadline_at - time.monotonic()
                if remaining <= 0:
                    state['reason'] = 'readiness_deadline'
                    raise TimeoutError('Native Save readiness deadline exceeded')
                matches = windows(visible=True, timeout=min(1, remaining))
                state['visibility_checks'] += 1
                state['visible_count'] = len(matches)
                if len(matches) > 1:
                    reject('ambiguous_dialogs')
                if matches:
                    if candidate is not None and matches[0] != candidate:
                        reject('replaced_dialog')
                    candidate = matches[0]
                    remaining = deadline_at - time.monotonic()
                    if remaining <= 0:
                        state['reason'] = 'readiness_deadline'
                        raise TimeoutError('Native Save readiness deadline exceeded')
                    # Revalidate the same visible window immediately before focusing it.
                    current = windows(visible=True, timeout=min(1, remaining))
                    state['visibility_checks'] += 1
                    state['visible_count'] = len(current)
                    if len(current) > 1:
                        reject('ambiguous_dialogs')
                    if current and current[0] != candidate:
                        reject('replaced_dialog')
                    if current:
                        remaining = deadline_at - time.monotonic()
                        if remaining <= 0:
                            state['reason'] = 'readiness_deadline'
                            raise TimeoutError('Native Save readiness deadline exceeded')
                        state['phase'] = 'focus'
                        subprocess.run(['xdotool', 'windowfocus', '--sync', candidate],
                                       capture_output=True, check=True, timeout=min(5, remaining))
                        break
                    state['disappeared_count'] += 1
                remaining = deadline_at - time.monotonic()
                if remaining > 0:
                    time.sleep(min(.25, remaining))
            assert not destination.exists()
            state['phase'] = 'select_destination'
            subprocess.run(['xdotool', 'key', 'ctrl+a'], capture_output=True, check=True, timeout=5)
            state['phase'] = 'type_destination'
            subprocess.run(['xdotool', 'type', '--clearmodifiers', str(destination)], capture_output=True, check=True, timeout=5)
            state['phase'] = 'confirm'
            subprocess.run(['xdotool', 'key', 'Return'], capture_output=True, check=True, timeout=5)
            state['phase'] = 'await_file'
            wait(lambda: destination.exists() and destination.stat().st_size > 0)
            state['phase'] = 'await_closed'

            def closed():
                current = windows()
                if any(window != candidate for window in current):
                    reject('replaced_dialog')
                return not current

            wait(closed)
            state['phase'] = 'complete'
        except subprocess.CalledProcessError as error:
            state.update(reason='command_failed', exitcode=error.returncode)
            raise
        except subprocess.TimeoutExpired:
            state['reason'] = 'command_timeout'
            raise
        finally:
            persist()

def endpoint_class(path):
    # Never retain raw paths: session/element IDs and URL values are not diagnostics.
    parts = path.split('/')
    if path == '/status':
        return 'status'
    if path == '/session':
        return 'create_session'
    if len(parts) < 3 or parts[1] != 'session':
        return 'other'
    suffix = parts[3:]
    fixed = {'url': 'navigation', 'timeouts': 'timeouts', 'elements': 'find_elements',
             'refresh': 'refresh', 'screenshot': 'screenshot', 'log': 'console_log',
             'actions': 'pointer_actions'}
    if len(suffix) == 1:
        return fixed.get(suffix[0], 'other')
    if suffix == ['execute', 'sync']:
        return 'sync_script'
    if suffix == ['execute', 'async']:
        return 'async_script'
    if len(suffix) >= 3 and suffix[0] == 'element':
        return {'click': 'element_click', 'value': 'element_input', 'displayed': 'element_displayed',
                'enabled': 'element_enabled', 'attribute': 'element_attribute',
                'elements': 'find_child_elements'}.get(suffix[2], 'other')
    return 'other'


AUTH_ACTIONS = {
    'open_signup', 'fill_display_name', 'fill_signup_email', 'fill_signup_password',
    'confirm_registration_policy', 'submit_signup', 'await_signup_navigation',
    'open_login', 'fill_login_email', 'fill_login_password', 'submit_login',
    'await_login_navigation', 'await_encryption_ready', 'open_account_settings', 'sign_out', 'await_signout_navigation',
}


def auth_progress(profile, action):
    if profile not in {0, 1, 2} or action not in AUTH_ACTIONS:
        raise ValueError('Auth diagnostic action is not allowlisted')
    metadata['auth_action'] = {'profile': profile, 'action': action}
    persist()


DM_MESSAGE_XPATH = '//li[@data-message-id][.//div[normalize-space(.)="Native community greeting"]]'
DM_LINK_XPATH = './/a[@aria-label="Message Native Bob privately"]'
DM_COMPOSER_XPATH = '//textarea[@id=//label[starts-with(normalize-space(.),"Message #")]/@for]'
DM_ACTIONS = {
    'open_member_channel', 'locate_community_composer', 'fill_community_message',
    'send_community_message', 'await_sender_message_commit', 'open_owner_channel',
    'await_owner_channel', 'locate_community_message',
    'hover_community_message', 'locate_private_message_link',
    'await_private_message_link_visible', 'await_private_message_link_enabled',
    'click_private_message_link', 'send_message_request', 'open_member_inbox',
    'select_message_request', 'accept_message_request', 'await_verify_device',
    'locate_encrypted_send', 'assert_unverified_send_disabled', 'start_device_verification',
    'accept_device_verification', 'show_verification_numbers', 'await_verification_numbers',
    'compare_verification_numbers', 'confirm_verification_numbers', 'await_verification_complete', 'fill_encrypted_message',
    'send_encrypted_message', 'await_encrypted_send_complete', 'await_encrypted_message', 'assert_ciphertext_transport',
    'reload_conversation', 'select_conversation', 'await_persisted_message',
    'check_recovery_controls', 'open_recovery_controls', 'create_recovery_backup',
    'save_recovery_file', 'validate_recovery_file', 'login_recovery_profile',
    'upload_recovery_file', 'open_recovered_archive', 'await_recovered_message',
    'reload_recovered_archive', 'remove_recovery_file', 'open_logout_settings',
    'sign_out', 'await_signout_navigation', 'open_protected_inbox', 'assert_logged_out',
}


def dm_progress(profile, action):
    if type(profile) is not int or profile not in {0, 1, 2} or action not in DM_ACTIONS:
        raise ValueError('DM diagnostic action is not allowlisted')
    metadata['dm_action'] = {'profile': profile, 'action': action}
    persist()


def open_dm_from_community(alice, bob, community_path):
    dm_progress(bob.profile, 'open_member_channel')
    bob.goto(community_path)
    dm_progress(bob.profile, 'locate_community_composer')
    composer = bob.element(DM_COMPOSER_XPATH)
    dm_progress(bob.profile, 'fill_community_message')
    bob.command('POST', '/element/' + composer + '/value', {'text': 'Native community greeting'})
    dm_progress(bob.profile, 'send_community_message')
    bob.click('Send message')
    dm_progress(bob.profile, 'await_sender_message_commit')
    message_id = bob.wait_sent_community_message()
    dm_progress(alice.profile, 'open_owner_channel')
    alice.goto(community_path)
    dm_progress(alice.profile, 'await_owner_channel')
    alice.wait_channel(community_path)
    alice.open_private_message(message_id)


def send_and_receive_dm(alice, bob, message):
    dm_progress(alice.profile, 'fill_encrypted_message')
    alice.fill('Encrypted message', message)
    dm_progress(alice.profile, 'send_encrypted_message')
    alice.click('Send encrypted message')
    dm_progress(alice.profile, 'await_encrypted_send_complete')
    alice.wait_dm_send_complete(message)
    dm_progress(bob.profile, 'await_encrypted_message')
    wait(lambda: bob.text(message), 60)


def dm_delivery_state(client, message, timeout=2):
    """Read actual selected DM UI; return only fixed counts, booleans and visibility."""
    peer = {0: 'Native Bob', 1: 'Native Alice'}[client.profile]
    snapshot = client.command('POST', '/execute/sync', {'args': [ORIGIN, peer, message], 'script': """
      const [origin, peer, expected] = arguments;
      const selected = Array.from(document.querySelectorAll('nav[aria-label="Home"] a[aria-current="page"]'));
      const logs = Array.from(document.querySelectorAll('[role="log"]')).filter(node => node.getAttribute('aria-label') === 'Private conversation with ' + peer);
      const list = logs.length === 1 ? logs[0].querySelector(':scope > ol') : null;
      const rows = list ? Array.from(list.children).filter(node => node.tagName === 'LI') : [];
      const paragraphs = row => Array.from(row.children).filter(node => node.tagName === 'P');
      const matches = row => paragraphs(row)[1]?.textContent === expected;
      const controls = Array.from(document.querySelectorAll('textarea#private-message'));
      const textarea = controls.length === 1 ? controls[0] : null;
      const buttons = textarea ? Array.from(textarea.form.querySelectorAll('button[type="submit"]')).filter(node => node.textContent.trim() === 'Send encrypted message') : [];
      const decryptError = 'Cannot decrypt or authenticate this message. Verify devices, sync, or restore a trusted history backup.';
      const failures = rows.map(row => paragraphs(row)[1]).filter(node => node?.textContent === decryptError);
      const stageCount = stage => failures.filter(node => node.getAttribute('data-dm-failure-stage') === stage).length;
      const codeCount = code => failures.filter(node => node.getAttribute('data-dm-failure-code') === code).length;
      const shieldFailures = failures.filter(node => node.getAttribute('data-dm-failure-stage') === 'shield');
      const shieldColorCount = color => shieldFailures.filter(node => node.getAttribute('data-dm-shield-color') === color).length;
      const shieldCodeCount = code => shieldFailures.filter(node => node.getAttribute('data-dm-shield-code') === code).length;
      return {
        at_messages: location.origin === origin && location.pathname === '/app/messages',
        visibility: document.visibilityState,
        selection_count: selected.length,
        target_selection_count: selected.filter(node => node.querySelector('[data-dm-peer-name]')?.textContent === peer).length,
        private_log_count: logs.length, message_row_count: rows.length,
        log_visible: logs.length === 1 && !!logs[0].getClientRects().length && getComputedStyle(logs[0]).visibility !== 'hidden',
        expected_plaintext_present: rows.some(matches),
        expected_plaintext_count: rows.filter(matches).length,
        own_plaintext_present: rows.some(row => matches(row) && paragraphs(row)[0]?.textContent.startsWith('You ·')),
        decrypt_error_count: rows.filter(row => paragraphs(row)[1]?.textContent === decryptError).length,
        failure_envelope_count: stageCount('envelope'),
        failure_sdk_decrypt_count: stageCount('sdk_decrypt'),
        failure_shield_count: stageCount('shield'),
        failure_sender_binding_count: stageCount('sender_binding'),
        failure_device_trust_count: stageCount('device_trust'),
        failure_plaintext_schema_count: stageCount('plaintext_schema'),
        failure_message_binding_count: stageCount('message_binding'),
        failure_history_schema_count: stageCount('history_schema'),
        failure_replay_storage_count: stageCount('replay_storage'),
        failure_missing_room_key_count: codeCount('MissingRoomKey'),
        failure_unknown_message_index_count: codeCount('UnknownMessageIndex'),
        failure_mismatched_identity_keys_count: codeCount('MismatchedIdentityKeys'),
        failure_unknown_sender_device_count: codeCount('UnknownSenderDevice'),
        failure_unsigned_sender_device_count: codeCount('UnsignedSenderDevice'),
        failure_sender_identity_verification_violation_count: codeCount('SenderIdentityVerificationViolation'),
        failure_unable_to_decrypt_count: codeCount('UnableToDecrypt'),
        failure_mismatched_sender_count: codeCount('MismatchedSender'),
        failure_unknown_code_count: codeCount('unknown'),
        failure_shield_color_red_count: shieldColorCount('Red'),
        failure_shield_color_grey_count: shieldColorCount('Grey'),
        failure_shield_color_none_count: shieldColorCount('None'),
        failure_shield_color_unknown_count: shieldColorCount('unknown'),
        failure_shield_authenticity_not_guaranteed_count: shieldCodeCount('AuthenticityNotGuaranteed'),
        failure_shield_unknown_device_count: shieldCodeCount('UnknownDevice'),
        failure_shield_unsigned_device_count: shieldCodeCount('UnsignedDevice'),
        failure_shield_unverified_identity_count: shieldCodeCount('UnverifiedIdentity'),
        failure_shield_verification_violation_count: shieldCodeCount('VerificationViolation'),
        failure_shield_mismatched_sender_count: shieldCodeCount('MismatchedSender'),
        failure_shield_unknown_code_count: shieldCodeCount('unknown'),
        textarea_count: controls.length, draft_empty: !!textarea && textarea.value === '',
        draft_matches: !!textarea && textarea.value === expected,
        textarea_enabled: !!textarea && !textarea.disabled,
        send_control_count: buttons.length, send_enabled: buttons.length === 1 && !buttons[0].disabled,
        disabled_control_count: controls.concat(buttons).filter(node => node.disabled).length,
        verification_count: document.querySelectorAll('section[aria-label="Device verification"]').length,
        alert_count: document.querySelectorAll('[role="alert"]').length
      };
    """}, timeout=timeout)
    safe = {'profile': client.profile, 'visibility': snapshot.get('visibility')
            if snapshot.get('visibility') in {'visible', 'hidden'} else 'other'}
    for key in ['selection_count', 'target_selection_count', 'private_log_count', 'message_row_count',
                'decrypt_error_count', 'textarea_count', 'send_control_count', 'disabled_control_count',
                'verification_count', 'alert_count', 'expected_plaintext_count',
                'failure_envelope_count', 'failure_sdk_decrypt_count', 'failure_shield_count',
                'failure_sender_binding_count', 'failure_device_trust_count', 'failure_plaintext_schema_count',
                'failure_message_binding_count', 'failure_history_schema_count', 'failure_replay_storage_count',
                'failure_missing_room_key_count', 'failure_unknown_message_index_count',
                'failure_mismatched_identity_keys_count', 'failure_unknown_sender_device_count',
                'failure_unsigned_sender_device_count', 'failure_sender_identity_verification_violation_count',
                'failure_unable_to_decrypt_count', 'failure_mismatched_sender_count', 'failure_unknown_code_count',
                'failure_shield_color_red_count', 'failure_shield_color_grey_count',
                'failure_shield_color_none_count', 'failure_shield_color_unknown_count',
                'failure_shield_authenticity_not_guaranteed_count', 'failure_shield_unknown_device_count',
                'failure_shield_unsigned_device_count', 'failure_shield_unverified_identity_count',
                'failure_shield_verification_violation_count', 'failure_shield_mismatched_sender_count',
                'failure_shield_unknown_code_count']:
        value = snapshot.get(key)
        if type(value) is int and 0 <= value <= 10000:
            safe[key] = value
    for key in ['at_messages', 'log_visible', 'expected_plaintext_present', 'own_plaintext_present',
                'draft_empty', 'draft_matches', 'textarea_enabled', 'send_enabled']:
        if type(snapshot.get(key)) is bool:
            safe[key] = snapshot[key]
    return safe


def gateway_timeout(end):
    remaining = end - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Gateway recovery phase deadline exceeded')
    return min(2, remaining)


def gateway_probe(client, end):
    """Public, uncached real request; its abort affects only this diagnostic GET."""
    timeout = gateway_timeout(end)
    value = client.command('POST', '/execute/async', {'args': [min(1000, timeout * 500)], 'script': """
      const milliseconds = arguments[0], done = arguments[arguments.length - 1];
      const controller = new AbortController();
      let expired = false;
      const timer = setTimeout(() => { expired = true; controller.abort(); }, milliseconds);
      fetch('/sign-in', {method: 'GET', cache: 'no-store', signal: controller.signal})
        .then(response => done({outcome: 'http_response', status_class: Math.floor(response.status / 100)}),
          () => done({outcome: expired ? 'deadline' : 'network_error'}))
        .finally(() => clearTimeout(timer));
    """}, timeout=timeout)
    if not isinstance(value, dict) or value.get('outcome') not in {'deadline', 'network_error', 'http_response'}:
        raise ValueError('Invalid public gateway probe outcome')
    safe = {'outcome': value['outcome']}
    if type(value.get('status_class')) is int and 1 <= value['status_class'] <= 5:
        safe['status_class'] = value['status_class']
    return safe


def gateway_dm_ready(state):
    return (all(state.get(key) is True for key in ['at_messages', 'log_visible'])
            and all(state.get(key) == 1 for key in ['selection_count', 'target_selection_count',
                                                  'private_log_count', 'textarea_count', 'send_control_count'])
            and state.get('visibility') == 'visible' and state.get('alert_count') == 0
            and state.get('decrypt_error_count') == 0)


def gateway_recovery(alice, bob, gateway, message, previous_message):
    """One genuine UI send through a confirmed, briefly stopped actual HTTPS gateway."""
    # Reserve 30s for this stage plus 180s for the measured baseline's later recovery/logout.
    if signal.getitimer(signal.ITIMER_REAL)[0] < 210:
        raise TimeoutError('Insufficient remaining native acceptance budget')
    end = time.monotonic() + 30
    state = metadata['gateway_recovery']

    def observe(client, expected=message):
        return dm_delivery_state(client, expected, timeout=gateway_timeout(end))

    def require(condition):
        if not condition:
            raise AssertionError('Gateway recovery invariant failed')

    for client in [alice, bob]:
        current = observe(client)
        require(gateway_dm_ready(current) and current.get('expected_plaintext_count') == 0
                and current.get('textarea_enabled') is True)
    # Resolve real, unique W3C controls while the gateway is still healthy.
    controls = []
    for xpath in ['//textarea[@id="private-message"]', '//button[normalize-space(.)="Send encrypted message"]']:
        values = alice.command('POST', '/elements', {'using': 'xpath', 'value': xpath}, timeout=gateway_timeout(end))
        require(len(values) == 1)
        controls.append(values[0][ELEMENT])
    composer, send = controls
    alice.command('POST', '/element/' + composer + '/value', {'text': message}, timeout=gateway_timeout(end))
    before = observe(alice)
    require(gateway_dm_ready(before) and before.get('draft_matches') is True and before.get('send_enabled') is True)
    require(alice.command('GET', '/element/' + send + '/enabled', timeout=gateway_timeout(end)) is True)
    health = gateway_probe(alice, end)
    state['health_status_class'] = health.get('status_class', 0)
    require(health == {'outcome': 'http_response', 'status_class': 2})

    with gateway.paused():
        proof = gateway_probe(alice, end)
        state['probe_outcome'] = proof['outcome']
        require(proof['outcome'] == 'deadline')
        # Exactly one native click, with no replay even if its response is lost.
        alice.command('POST', '/element/' + send + '/click', {}, timeout=gateway_timeout(end))
        pending = observe(alice)
        recipient = observe(bob)
        state['draft_retained'] = pending.get('draft_matches') is True
        state['busy'] = pending.get('textarea_enabled') is False and pending.get('send_enabled') is False
        require(gateway_dm_ready(pending) and gateway_dm_ready(recipient)
                and state['draft_retained'] and state['busy']
                and pending.get('disabled_control_count') == 2
                and pending.get('expected_plaintext_count') == 0
                and recipient.get('expected_plaintext_count') == 0)

    health = gateway_probe(alice, end)
    state['health_status_class'] = health.get('status_class', 0)
    require(health == {'outcome': 'http_response', 'status_class': 2})
    while True:
        sender, recipient = observe(alice), observe(bob)
        require(gateway_dm_ready(sender) and gateway_dm_ready(recipient))
        require(sender.get('expected_plaintext_count', 0) <= 1 and recipient.get('expected_plaintext_count', 0) <= 1)
        if (sender.get('expected_plaintext_count') == recipient.get('expected_plaintext_count') == 1
                and sender.get('own_plaintext_present') is True and sender.get('draft_empty') is True
                and sender.get('textarea_enabled') is True):
            state['delivered_once'] = True
            break
        time.sleep(min(.25, gateway_timeout(end)))
    for client in [alice, bob]:
        previous = observe(client, previous_message)
        require(gateway_dm_ready(previous) and previous.get('expected_plaintext_count') == 1)
    safe = alice.command('POST', '/execute/async', {'args': [message], 'script': """
      const text = arguments[0], done = arguments[arguments.length - 1];
      fetch('/api/dm', {cache: 'no-store'}).then(r => { if (!r.ok) throw Error(); return r.json(); })
        .then(async r => { const id = r.conversations[0].id;
          const response = await fetch('/api/dm?conversation=' + encodeURIComponent(id), {cache: 'no-store'});
          done(response.ok && !(await response.text()).includes(text)); }).catch(() => done(false));
    """}, timeout=gateway_timeout(end))
    require(safe is True)


def dm_diagnostics(client, timeout=2):
    """One failure-only read: no DOM, text, identifiers or private SDK state returned."""
    snapshot = client.command('POST', '/execute/sync', {'args': [DM_MESSAGE_XPATH, DM_LINK_XPATH, DM_COMPOSER_XPATH], 'script': """
      const matches = (xpath, root) => {
        const result = document.evaluate(xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return Array.from({length: result.snapshotLength}, (_, i) => result.snapshotItem(i));
      };
      const routes = {'/sign-in': 'sign-in', '/app/messages': 'messages', '/app/settings': 'settings'};
      const messages = matches(arguments[0], document);
      const links = messages.length === 1 ? matches(arguments[1], messages[0]) : [];
      const zeroOpacity = node => {
        for (let current = node; current; current = current.parentElement) {
          if (Number(getComputedStyle(current).opacity) === 0) return true;
        }
        return false;
      };
      const route = routes[location.pathname] || (/^\\/app\\/c\\/[^/]+\\/settings$/.test(location.pathname) ? 'community-settings'
        : /^\\/app\\/c\\/[^/]+\\/[^/]+$/.test(location.pathname) ? 'channel' : 'other');
      const summary = {route,
        message_count: messages.length, link_count: links.length,
        pending_count: document.querySelectorAll('[role="log"] li[aria-label="Sending"]').length,
        channel_log_count: document.querySelectorAll('[role="log"][aria-label^="Messages in #"]').length,
        composer_count: matches(arguments[2], document).length,
        verification_count: document.querySelectorAll('[data-verification-code]').length,
        alert_count: document.querySelectorAll('[role="alert"]').length};
      if (messages.length === 1) summary.message_hovered = messages[0].matches(':hover');
      if (links.length === 1) {
        summary.link_zero_opacity = zeroOpacity(links[0]);
        summary.link_has_rect = !!links[0].getClientRects().length;
      }
      return summary;
    """}, timeout=timeout)
    safe = {'profile': client.profile, 'route': snapshot.get('route') if snapshot.get('route') in {
        'sign-in', 'messages', 'settings', 'community-settings', 'channel', 'other',
    } else 'other'}
    for key in ['message_count', 'link_count', 'pending_count', 'channel_log_count',
                'composer_count', 'verification_count', 'alert_count']:
        value = snapshot.get(key)
        if type(value) is int and 0 <= value <= 10000:
            safe[key] = value
    for key in ['message_hovered', 'link_zero_opacity', 'link_has_rect']:
        if type(snapshot.get(key)) is bool:
            safe[key] = snapshot[key]
    return safe


def at_app_path(url, path):
    actual = urllib.parse.urlsplit(url)
    expected = urllib.parse.urlsplit(ORIGIN + path)
    return (actual.scheme, actual.netloc, actual.path) == (expected.scheme, expected.netloc, expected.path)


def auth_destination_reached(snapshot, path):
    return snapshot['protected_content'] is True and at_app_path(snapshot['url'], path)


def channel_destination_reached(snapshot, path):
    parts = path.split('/')
    if len(parts) != 5 or parts[:3] != ['', 'app', 'c']:
        return False
    try:
        uuid.UUID(parts[3])
        uuid.UUID(parts[4])
    except ValueError:
        return False
    return (at_app_path(snapshot['url'], path)
            and snapshot['channel_log_count'] == 1 and snapshot['composer_count'] == 1)


def auth_diagnostics(client, timeout=2):
    """Failure-only public session observation; never return session/user fields."""
    snapshot = client.command('POST', '/execute/async', {'args': [ORIGIN, int(timeout * 750)], 'script': """
      const done = arguments[arguments.length - 1];
      const origin = arguments[0];
      const limit = arguments[1];
      const routes = {'/sign-in': 'sign-in', '/sign-up': 'sign-up', '/app': 'app', '/app/messages': 'messages'};
      const visible = node => !!(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
      const count = selector => Array.from(document.querySelectorAll(selector)).filter(visible).length;
      const summary = {
        route: routes[location.pathname] || 'other',
        forms: count('form'), invalid_controls: count('form input:invalid'),
        alerts: count('form [role="alert"]'), notices: count('form [role="status"]'),
        pending: Array.from(document.querySelectorAll('form button[type="submit"]')).some(node => visible(node) && node.disabled && node.textContent.trim() === 'Please wait…')
      };
      if (location.origin !== origin) { done(summary); return; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limit);
      fetch('/api/auth/get-session', {method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal})
        .then(async response => {
          summary.http_status = response.status;
          const body = await response.json();
          summary.authenticated = response.ok && !!(body && body.session && body.user);
        })
        .catch(() => {})
        .finally(() => { clearTimeout(timer); done(summary); });
    """}, timeout=timeout)
    # Defense at the artifact boundary: retain only the fixed schema, never extra fields.
    safe = {'profile': client.profile, 'route': snapshot.get('route') if snapshot.get('route') in {
        'sign-in', 'sign-up', 'app', 'messages', 'other',
    } else 'other'}
    for key in ['forms', 'invalid_controls', 'alerts', 'notices', 'http_status']:
        value = snapshot.get(key)
        if type(value) is int and value >= 0:
            safe[key] = value
    for key in ['pending', 'authenticated']:
        if type(snapshot.get(key)) is bool:
            safe[key] = snapshot[key]
    return safe


def failure_diagnostics(clients, budget=10, *, delivery_message=None):
    """Called inside the existing global diagnostic timer, sharing its total budget."""
    deadline_at = time.monotonic() + budget
    if any(results[name]['status'] == 'failed' for name in [
            'dm_enrollment', 'dm_sas_delivery', 'dm_persistence', 'dm_gateway_recovery', 'dm_recovery', 'logout']):
        # Keep the failed application command before read-only diagnostics replace it.
        metadata['dm_failed_request'] = dict(metadata.get('last_native_request', {}))
        profile = metadata.get('dm_action', {}).get('profile')
        client = next((client for client in clients if client.profile == profile), None)
        remaining = deadline_at - time.monotonic()
        if results['dm_sas_delivery']['status'] == 'failed' and delivery_message is not None:
            observations = []
            metadata['dm_peer_diagnostics'] = observations
            for peer in clients:
                remaining = deadline_at - time.monotonic()
                if peer.profile not in {0, 1} or remaining <= 0:
                    continue
                try:
                    observations.append(dm_delivery_state(peer, delivery_message, timeout=min(2, remaining)))
                except NativeDeadlineExpired:
                    raise
                except Exception as error:
                    observations.append({'profile': peer.profile, 'error_type': type(error).__name__})
        elif client is not None and remaining > 0:
            try:
                metadata['dm_diagnostic'] = dm_diagnostics(client, timeout=min(2, remaining))
            except NativeDeadlineExpired:
                raise
            except Exception as error:
                metadata['dm_diagnostic_error_type'] = type(error).__name__
    if any(results[name]['status'] == 'failed' for name in ['signup_login', 'dm_recovery']):
        profile = metadata.get('auth_action', {}).get('profile')
        client = next((client for client in clients if client.profile == profile), None)
        remaining = deadline_at - time.monotonic()
        if client is not None and remaining > 0:
            try:
                metadata['auth_diagnostic'] = auth_diagnostics(client, timeout=min(2, remaining))
            except NativeDeadlineExpired:
                raise
            except Exception as error:
                metadata['auth_diagnostic_error_type'] = type(error).__name__
    metadata['transport_diagnostic'] = transport_diagnostics(clients, budget=max(0, deadline_at - time.monotonic()))


# Exact fixed output literals from installed tauri-driver 2.1.0 src/server.rs/main.rs.
DRIVER_SIGNATURES = {
    'connection_error': b'Error serving connection:',
    'accept_error': b'accept new stream fail, ignore here',
    'listen_error': b'can not listen to address:',
    'server_error': b'error while running server:',
}


# Debug enum names verified against locked hyper-util0.1.19 / hyper1.8.1 sources.
LEGACY_ERROR_KINDS = ('Canceled', 'ChannelClosed', 'Connect', 'UserUnsupportedRequestMethod',
                      'UserUnsupportedVersion', 'UserAbsoluteUriRequired', 'SendRequest')
HYPER_ERROR_KINDS = ('Parse', 'User', 'IncompleteMessage', 'UnexpectedMessage', 'Canceled',
                     'ChannelClosed', 'Io', 'HeaderTimeout', 'Body', 'BodyWrite', 'Shutdown', 'Http2')
HYPER_USER_KINDS = ('Body', 'BodyWriteAborted', 'InvalidConnectWithBody', 'Service',
                    'UnexpectedHeader', 'UnsupportedStatusCode', 'NoUpgrade', 'ManualUpgrade',
                    'DispatchGone', 'AbortedByCallback')
HYPER_CAUSE_PHRASES = {
    'canceled': b'operation was canceled',
    'incomplete_message': b'connection closed before message completed',
    'channel_closed': b'channel closed',
    'invalid_content_length': b'invalid content-length parsed',
    'invalid_header': b'invalid HTTP header parsed',
    'body_read': b'error reading a body from connection',
    'body_write': b'error writing a body to connection',
    'shutdown': b'error shutting down connection',
    'connection_io': b'connection error',
}


def driver_error_categories(data):
    categories = {'legacy': {kind: 0 for kind in LEGACY_ERROR_KINDS},
                  'hyper': {kind: 0 for kind in HYPER_ERROR_KINDS},
                  'hyper_user': {kind: 0 for kind in HYPER_USER_KINDS},
                  'legacy_display': {kind: 0 for kind in LEGACY_ERROR_KINDS},
                  'hyper_cause': {kind: 0 for kind in HYPER_CAUSE_PHRASES}}
    lines = data.splitlines()
    for index, line in enumerate(lines):
        if not line.startswith(DRIVER_SIGNATURES['connection_error']):
            continue
        # anyhow1.0.103 Debug renders Display plus indented Caused by lines.
        block = [line]
        for continuation in lines[index + 1:index + 13]:
            if not continuation or continuation == b'Caused by:' or continuation.startswith((b' ', b'\t')):
                block.append(continuation)
            else:
                break
        block = b'\n'.join(block)
        for family, pattern in [('legacy', rb'hyper_util::client::legacy::Error\(([A-Za-z]+)[,)]'),
                                ('hyper', rb'hyper::Error\(([A-Za-z]+)[(,)]'),
                                ('hyper_user', rb'hyper::Error\(User\(([A-Za-z]+)\)'),
                                ('legacy_display', rb'client error \(([A-Za-z]+)\)')]:
            for match in re.finditer(pattern, block):
                name = match.group(1).decode('ascii')
                if name in categories[family]:
                    categories[family][name] += 1
        for kind, phrase in HYPER_CAUSE_PHRASES.items():
            categories['hyper_cause'][kind] += block.count(phrase)
    return categories


class ContractDeadline(TimeoutError):
    pass


def transport_contract(client, budget=20):
    """Pre-auth read-only diagnostic; never changes/replaces the main transport."""
    names = ('urllib_tauri', 'urllib_native', 'persistent_tauri')
    outcomes = {name: {'status': 'not-run'} for name in names}
    started = time.monotonic()
    old_remaining, old_interval = signal.getitimer(signal.ITIMER_REAL)

    def deadline(_signal, _frame):
        raise ContractDeadline('Read-only transport contract deadline')

    old_handler = signal.signal(signal.SIGALRM, deadline)
    limit = min(budget, old_remaining) if old_remaining > 0 else budget
    signal.setitimer(signal.ITIMER_REAL, limit)
    try:
        for name in names:
            outcome = {'status': 'running', 'commands': []}
            outcomes[name] = outcome
            connection = None
            if name == 'persistent_tauri':
                connection = http.client.HTTPConnection('127.0.0.1', client.port, timeout=1)

            def request(method, path, body=None):
                remaining = limit - (time.monotonic() - started)
                if remaining <= 0:
                    raise ContractDeadline('Read-only transport contract deadline')
                timeout = min(1, remaining)
                encoded = json.dumps(body).encode() if body is not None else None
                command = {'endpoint': endpoint_class(path), 'method': method}
                outcome['commands'].append(command)
                if connection is not None:
                    connection.timeout = timeout
                    if connection.sock is not None:
                        connection.sock.settimeout(timeout)
                    connection.request(method, path, body=encoded, headers={'Content-Type': 'application/json'})
                    response = connection.getresponse()
                else:
                    port = client.port + 1 if name == 'urllib_native' else client.port
                    req = urllib.request.Request(f'http://127.0.0.1:{port}' + path, encoded,
                        {'Content-Type': 'application/json'}, method=method)
                    response = urllib.request.urlopen(req, timeout=timeout)
                with response:
                    command['http_status'] = response.status
                    if response.status != 200:
                        raise RuntimeError('Read-only transport contract HTTP failure')
                    return json.load(response)['value']

            try:
                request('GET', '/status')
                prefix = '/session/' + client.session
                elements = request('POST', prefix + '/elements', {'using': 'css selector', 'value': 'html'})
                outcome['lookup_shape'] = {
                    'value_type': 'array' if isinstance(elements, list) else 'object' if isinstance(elements, dict) else 'other',
                    'list_count': len(elements) if isinstance(elements, list) else None,
                    'reference_valid': (isinstance(elements, list) and len(elements) == 1
                        and isinstance(elements[0], dict) and isinstance(elements[0].get(ELEMENT), str)),
                }
                if not outcome['lookup_shape']['reference_valid']:
                    raise ValueError('Public document control contract failed')
                identifier = elements[0][ELEMENT]
                displayed = request('GET', prefix + '/element/' + identifier + '/displayed')
                enabled = request('GET', prefix + '/element/' + identifier + '/enabled')
                if displayed is not True or enabled is not True:
                    raise ValueError('Public document control contract failed')
                executed = request('POST', prefix + '/execute/sync', {'script': 'return true', 'args': []})
                if executed is not True:
                    raise ValueError('Public read-only script contract failed')
                outcome['status'] = 'passed'
            except ContractDeadline:
                outcome['status'] = 'deadline_exceeded'
                break
            except urllib.error.HTTPError as error:
                outcome['status'] = 'failed'
                outcome['http_status'] = error.code
                error.close()
            except Exception as error:
                outcome['status'] = 'failed'
                outcome['error_type'] = type(error).__name__
            finally:
                if connection is not None:
                    connection.close()
    except ContractDeadline:
        for outcome in outcomes.values():
            if outcome['status'] == 'running':
                outcome['status'] = 'deadline_exceeded'
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)
        elapsed = time.monotonic() - started
        if old_remaining > 0:
            signal.setitimer(signal.ITIMER_REAL, max(.001, old_remaining - elapsed), old_interval)
    return {'scope': 'pre-auth read-only native transport diagnostic; no application-flow acceptance',
            'variants': outcomes, 'seconds': round(time.monotonic() - started, 2)}


class NoProbeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def transport_diagnostics(clients, budget=10):
    """One bounded observation, no command replay and no raw logs/body retention."""
    started = time.monotonic()
    deadline_at = started + budget
    observations = []
    opener = urllib.request.build_opener(NoProbeRedirect())

    def probe(url):
        remaining = deadline_at - time.monotonic()
        if remaining <= 0:
            return {'state': 'budget_exhausted'}
        try:
            with opener.open(url, timeout=min(1, remaining)) as response:
                return {'status': response.status}
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            return {'status': status}
        except Exception as error:
            return {'error_type': type(error).__name__}

    for client in clients:
        entry = {'profile': client.profile, 'driver_exitcode': client.process.poll()}
        try:
            size = os.fstat(client.log.fileno()).st_size
            # Read at most 64 KiB without changing the shared output descriptor's offset.
            data = os.pread(client.log.fileno(), min(size, 65536), max(0, size - 65536))
            entry['driver_log_sampled'] = size > 65536
            entry['driver_signatures'] = {key: data.count(marker) for key, marker in DRIVER_SIGNATURES.items()}
            entry['driver_error_categories'] = driver_error_categories(data)
        except OSError as error:
            entry['driver_log_error_type'] = type(error).__name__
        entry['intermediary_status'] = probe(f'http://127.0.0.1:{client.port}/status')
        entry['native_status'] = probe(f'http://127.0.0.1:{client.port + 1}/status')
        observations.append(entry)
    summary = {'profiles': observations, 'app_health': probe(ORIGIN + '/sign-in')}
    try:
        memory = {}
        for line in pathlib.Path('/proc/meminfo').read_text().splitlines():
            key, value = line.split(':', 1)
            if key in {'MemTotal', 'MemAvailable', 'SwapFree'}:
                memory[key] = int(value.split()[0])
        summary['memory_kib'] = memory
    except (OSError, ValueError):
        summary['memory_available'] = False
    summary['seconds'] = round(time.monotonic() - started, 2)
    return summary


COMMUNITY_ACTIONS = {
    'open_home', 'open_create_dialog', 'fill_community_name', 'submit_create',
    'await_general', 'read_community_path', 'open_invite_dialog', 'create_invite',
    'read_invite', 'open_member_invite', 'accept_invite', 'await_member_general',
    'return_owner_channel', 'capture_community',
}


def community_progress(action):
    if action not in COMMUNITY_ACTIONS:
        raise ValueError('Diagnostic action is not allowlisted')
    metadata['community_action'] = action
    persist()


@contextmanager
def diagnose_community(owner, member):
    """Only early community UI: fixed counts and route classes, never DOM/value dumps."""
    try:
        yield
    except BaseException:
        client = member if metadata.get('community_action') in {
            'open_member_invite', 'accept_invite', 'await_member_general',
        } else owner
        try:
            snapshot = client.command('POST', '/execute/sync', {'args': [], 'script': """
              const visible = node => !!(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
              const buttons = Array.from(document.querySelectorAll('button'));
              const count = text => {
                const nodes = buttons.filter(node => node.getAttribute('aria-label') === text || node.textContent.trim() === text);
                return {matched: nodes.length, visible: nodes.filter(visible).length};
              };
              return {
                route: location.pathname === '/app' ? 'app' : location.pathname.startsWith('/app/c/') ? 'community' : location.pathname === '/sign-in' ? 'sign-in' : location.pathname.startsWith('/invite/') ? 'invite' : 'other',
                controls: {
                  create_community: count('Create a community'), create: count('Create'),
                  invite_people: count('Invite people'), create_invite: count('Create invite link'),
                  accept_invite: count('Accept invite')
                },
                name_labels: Array.from(document.querySelectorAll('label')).filter(node => node.textContent.trim() === 'Name').length,
                safe_screenshot: location.pathname.startsWith('/app') && !document.querySelector('input[type=password], #invite-link')
              };
            """}, timeout=2)
            # Keys and values above are fixed classes/counts; do not add DOM or URL values.
            metadata['community_diagnostic'] = snapshot
            if snapshot['safe_screenshot']:
                client.screenshot('early-community-failure', timeout=3)
        except Exception as error:
            metadata['community_diagnostic_error_type'] = type(error).__name__
        persist()
        raise


def cleanup_clients(clients, budget=10):
    """Signal every captured session group before waiting; never call a hung driver."""
    deadline_at = time.monotonic() + budget
    errors = []
    # Each PID is the session/group leader created by our start_new_session Popen.
    for client in clients:
        try:
            os.killpg(client.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError as error:
            errors.append(type(error).__name__)
    for client in clients:
        try:
            client.connection.close()
        except OSError as error:
            errors.append(type(error).__name__)
    grace_end = min(deadline_at, time.monotonic() + 3)
    for client in clients:
        try:
            client.process.wait(timeout=max(0, grace_end - time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
        except OSError as error:
            errors.append(type(error).__name__)
    for client in clients:
        try:
            os.killpg(client.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError as error:
            errors.append(type(error).__name__)
    for client in clients:
        try:
            client.process.wait(timeout=max(0, deadline_at - time.monotonic()))
        except subprocess.TimeoutExpired:
            errors.append('ProcessReapDeadline')
        except OSError as error:
            errors.append(type(error).__name__)
        finally:
            try:
                client.log.close()
            except OSError as error:
                errors.append(type(error).__name__)
    return errors


def complete_json(path, valid):
    """A closed Save dialog is consent, not a completed WebKit download."""
    def read_complete():
        try:
            value = json.loads(path.read_text())
        except (FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) and valid(value) else None
    return wait(read_complete)


def recovery_shape(value):
    keys = {'format', 'version', 'origin', 'userId', 'backupId', 'encryptionInfo'}
    if set(value) != keys or value['format'] != 'opendiscord.e2ee-recovery' or value['version'] != 2:
        return False
    if value['origin'] != ORIGIN or not isinstance(value['userId'], str) or not value['userId']:
        return False
    if not isinstance(value['encryptionInfo'], str) or not 0 < len(value['encryptionInfo']) <= 4000:
        return False
    try:
        uuid.UUID(value['backupId'])
    except (ValueError, TypeError, AttributeError):
        return False
    return True


def export_shape(value):
    return (value.get('format') == 'opendiscord.community-export' and value.get('version') == 2
            and isinstance(value.get('community'), dict)
            and value['community'].get('name') == 'Native Acceptance Community'
            and all(isinstance(value.get(key), list) for key in
                    ['assets', 'roles', 'categories', 'channels', 'messages'])
            and len(value['channels']) >= 1 and len(value['messages']) >= 1
            and all(isinstance(message, dict) and isinstance(message.get('content'), str)
                    and isinstance(message.get('attachments'), int) for message in value['messages'])
            and isinstance(value.get('exportedAt'), str) and isinstance(value.get('truncated'), bool))


def unsupported_command(error):
    # Keep only the W3C identifier; messages/stacks can contain private DOM or files.
    try:
        value = json.loads(error.read()).get('value')
    except (ValueError, OSError):
        return False
    return isinstance(value, dict) and value.get('error') in {'unknown command', 'unsupported operation'}


def main():
    metadata['platform'] = os.uname().sysname + ' ' + os.uname().release
    metadata['webkit_package'] = subprocess.run(['dpkg-query', '-W', '-f=${Version}', 'libwebkit2gtk-4.1-0'], capture_output=True, text=True, check=True, timeout=5).stdout
    persist()
    clients = []
    gateway = None
    delivery_message = None
    with tempfile.TemporaryDirectory(prefix='native-app-flows-') as directory:
        sandbox = pathlib.Path(directory)
        try:
            with stage('native_profile_capabilities'):
                gateway = OwnedGateway()
                for index in range(3):
                    client = Native(index, sandbox)
                    clients.append(client)
                    client.start()
                    capabilities = client.async_script('''const done=arguments[arguments.length-1];
                      (async()=>{ const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('native-capability',1);r.onsuccess=()=>resolve(r.result);r.onerror=reject});db.close();
                        return await navigator.locks.request('native-capability',()=>WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0]))); })().then(done,()=>done(false));''')
                    assert capabilities is True
                    client.script('localStorage.setItem("native-profile",arguments[0]);return true', str(index))
                assert [c.script('return localStorage.getItem("native-profile")') for c in clients] == ['0', '1', '2']
                # Probe real application file input after enrollment below; never synthetic inputs.
            alice, bob, recovered = clients
            with stage('signup_login'):
                email = alice.signup('Native Alice')
                bob.signup('Native Bob')
                auth_progress(alice.profile, 'open_account_settings')
                alice.goto('/app/settings')
                auth_progress(alice.profile, 'sign_out')
                alice.click('Sign out')
                auth_progress(alice.profile, 'await_signout_navigation')
                alice.finish_sign_out()
                alice.login(email)
            with stage('community_navigation'), diagnose_community(alice, bob):
                community_progress('open_home')
                alice.goto('/app')
                community_progress('open_create_dialog')
                alice.click('Create a community')
                community_progress('fill_community_name')
                alice.fill('Name', 'Native Acceptance Community')
                community_progress('submit_create')
                alice.click('Create')
                community_progress('await_general')
                wait(lambda: alice.text('general'))
                community_progress('read_community_path')
                community_path = urllib.parse.urlsplit(alice.command('GET', '/url')).path
                community_progress('open_invite_dialog')
                alice.click('Invite people')
                community_progress('create_invite')
                alice.click('Create invite link')
                community_progress('read_invite')
                invite = wait(lambda: alice.script('return document.querySelector("input[readonly]")?.value'))
                community_progress('open_member_invite')
                bob.goto(urllib.parse.urlsplit(invite).path)
                community_progress('accept_invite')
                bob.click('Accept invite')
                community_progress('await_member_general')
                wait(lambda: bob.text('general'))
                community_progress('return_owner_channel')
                alice.goto(community_path)
                community_progress('capture_community')
                alice.screenshot('community')
            with stage('private_attachment'):
                payload = b'Native private attachment acceptance\n'
                upload = sandbox / 'native-proof.txt'
                upload.write_bytes(payload)
                # Composer input is hidden by design; W3C file upload accepts the actual input.
                values = alice.command('POST', '/elements', {'using': 'css selector', 'value': 'input[type=file]'})
                assert values
                alice.command('POST', '/element/' + values[0][ELEMENT] + '/value', {'text': str(upload)})
                wait(lambda: alice.text('native-proof.txt'))
                alice.click('Send message')
                wait(lambda: bob.text('native-proof.txt'))
                identifier = bob.element('//a[contains(.,"native-proof.txt")]')
                attachment_url = bob.command('GET', '/element/' + identifier + '/attribute/href')
                status = recovered.async_script('fetch(arguments[0]).then(r=>arguments[arguments.length-1](r.status))', attachment_url)
                assert status in [401, 403, 404]
                downloaded = sandbox / 'attachment.txt'
                bob.save(downloaded, lambda: bob.command('POST', '/element/' + identifier + '/click', {}))
                wait(lambda: downloaded.read_bytes() == payload)
                metadata['attachment'] = {'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload), 'outsider_status': status}
            with stage('community_export'):
                alice.click('Community settings', 'a')
                exported = sandbox / 'community.json'
                alice.save(exported, lambda: alice.click('Download community export', 'a'))
                data = complete_json(exported, export_shape)
                assert data['format'] == 'opendiscord.community-export'
                assert len(data['messages']) >= 1
            with stage('dm_enrollment'):
                # Post a community message from Bob, then use the actual private-message link.
                open_dm_from_community(alice, bob, community_path)
                dm_progress(alice.profile, 'send_message_request')
                alice.click('Send message request')
                dm_progress(bob.profile, 'open_member_inbox')
                bob.goto('/app/messages')
                dm_progress(bob.profile, 'select_message_request')
                bob.open_conversation('Native Alice')
                dm_progress(bob.profile, 'accept_message_request')
                bob.click('Accept message request')
                # Trust on first use: sending works without SAS; verification is the optional upgrade.
                dm_progress(alice.profile, 'locate_encrypted_send')
                alice.element('//textarea[@id="private-message"]')
                dm_progress(alice.profile, 'await_verify_device')
                alice.click('Devices and recovery')
                wait(lambda: alice.text('Verify device'))
            with stage('dm_sas_delivery'):
                secret_message = 'Disposable native encrypted delivery 73192'
                delivery_message = secret_message
                dm_progress(alice.profile, 'start_device_verification')
                alice.prefix_click('Verify device ')
                dm_progress(bob.profile, 'accept_device_verification')
                bob.click('Accept verification')
                dm_progress(alice.profile, 'show_verification_numbers')
                alice.click('Show verification numbers')
                dm_progress(alice.profile, 'await_verification_numbers')
                code_a = wait(lambda: alice.script('return document.querySelector("[data-verification-code]")?.textContent'))
                dm_progress(bob.profile, 'await_verification_numbers')
                code_b = wait(lambda: bob.script('return document.querySelector("[data-verification-code]")?.textContent'))
                dm_progress(alice.profile, 'compare_verification_numbers')
                assert code_a == code_b
                del code_a, code_b
                dm_progress(alice.profile, 'confirm_verification_numbers')
                alice.click('The numbers match')
                dm_progress(bob.profile, 'confirm_verification_numbers')
                bob.click('The numbers match')
                # Confirmation sends protocol messages; each SDK still has to consume them.
                for client in [alice, bob]:
                    dm_progress(client.profile, 'await_verification_complete')
                    wait(lambda: client.text('Verification complete.'), 60)
                send_and_receive_dm(alice, bob, secret_message)
                dm_progress(alice.profile, 'assert_ciphertext_transport')
                safe_transport = alice.async_script('''const done=arguments[arguments.length-1], text=arguments[0];
                  fetch('/api/dm').then(r=>r.json()).then(async r=>{const id=r.conversations[0].id;const response=await fetch('/api/dm?conversation='+encodeURIComponent(id));done(response.ok && !(await response.text()).includes(text));}).catch(()=>done(false));''', secret_message)
                assert safe_transport
            with stage('dm_persistence'):
                dm_progress(bob.profile, 'reload_conversation')
                bob.command('POST', '/refresh', {})
                dm_progress(bob.profile, 'select_conversation')
                bob.open_conversation('Native Alice')
                dm_progress(bob.profile, 'await_persisted_message')
                wait(lambda: bob.text(secret_message), 60)
            with stage('dm_gateway_recovery'):
                outage_message = 'Disposable native gateway recovery ' + uuid.uuid4().hex
                gateway_recovery(alice, bob, gateway, outage_message, secret_message)
            with stage('dm_recovery'):
                dm_progress(alice.profile, 'check_recovery_controls')
                if not alice.text('Create encrypted recovery backup'):
                    dm_progress(alice.profile, 'open_recovery_controls')
                    alice.click('Devices and recovery')
                dm_progress(alice.profile, 'create_recovery_backup')
                alice.click('Create encrypted recovery backup')
                recovery = sandbox / 'recovery.json'
                dm_progress(alice.profile, 'save_recovery_file')
                alice.save(recovery, lambda: alice.click('Download your private recovery file', 'a'))
                dm_progress(alice.profile, 'validate_recovery_file')
                complete_json(recovery, recovery_shape)
                dm_progress(recovered.profile, 'login_recovery_profile')
                recovered.login(email)
                dm_progress(recovered.profile, 'open_recovery_controls')
                recovered.click('Devices and recovery')
                dm_progress(recovered.profile, 'upload_recovery_file')
                recovered.upload('//label[starts-with(normalize-space(.),"Open encrypted recovery archive")]//input', recovery)
                dm_progress(recovered.profile, 'open_recovered_archive')
                summary = recovered.element('//summary[starts-with(normalize-space(.),"View recovered archive")]')
                recovered.command('POST', '/element/' + summary + '/click', {})
                dm_progress(recovered.profile, 'await_recovered_message')
                wait(lambda: recovered.text(secret_message) and recovered.text(outage_message), 60)
                dm_progress(recovered.profile, 'reload_recovered_archive')
                recovered.command('POST', '/refresh', {})
                dm_progress(recovered.profile, 'open_recovered_archive')
                summary = recovered.element('//summary[starts-with(normalize-space(.),"View recovered archive")]')
                recovered.command('POST', '/element/' + summary + '/click', {})
                dm_progress(recovered.profile, 'await_recovered_message')
                wait(lambda: recovered.text(secret_message) and recovered.text(outage_message), 60)
                dm_progress(recovered.profile, 'remove_recovery_file')
                recovery.unlink()
            with stage('logout'):
                dm_progress(bob.profile, 'open_logout_settings')
                bob.goto('/app/settings')
                dm_progress(bob.profile, 'sign_out')
                bob.click('Sign out')
                dm_progress(bob.profile, 'await_signout_navigation')
                bob.finish_sign_out()
                dm_progress(bob.profile, 'open_protected_inbox')
                bob.goto('/app/messages')
                dm_progress(bob.profile, 'assert_logged_out')
                wait(lambda: at_app_path(bob.command('GET', '/url'), '/sign-in'))
            with stage('runtime_errors'):
                unavailable = 0
                for client in clients:
                    try:
                        logs = client.command('POST', '/log', {'type': 'browser'})
                    except urllib.error.HTTPError as error:
                        if not unsupported_command(error):
                            raise RuntimeError('WebDriver console endpoint failed') from None
                        unavailable += 1
                    else:
                        assert not any(entry.get('level') == 'SEVERE' for entry in logs)
                metadata['console_endpoint_unavailable_profiles'] = unavailable
                if unavailable:
                    results['runtime_errors']['status'] = 'unavailable'
        finally:
            primary_error = sys.exception()
            signal.alarm(0)
            gateway_error = None
            if gateway is not None:
                blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM, signal.SIGTERM, signal.SIGINT})
                try:
                    gateway.resume()
                except Exception as error:
                    gateway_error = type(error).__name__
                    metadata['gateway_resume_error_type'] = gateway_error
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
            if primary_error is not None and gateway_error is None:
                signal.setitimer(signal.ITIMER_REAL, 10)
                try:
                    failure_diagnostics(clients, delivery_message=delivery_message)
                except Exception as error:
                    metadata['transport_diagnostic_error_type'] = type(error).__name__
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
            errors = cleanup_clients(list(reversed(clients)))
            if gateway is not None:
                gateway.close()
            if gateway_error is not None:
                errors.append('gateway_resume_' + gateway_error)
            metadata['cleanup_errors'] = errors
            persist()
            if errors:
                if primary_error is not None:
                    primary_error.add_note('Owned native cleanup errors: ' + ', '.join(errors))
                else:
                    raise RuntimeError('Owned native process cleanup failed')


def deadline(_signal, _frame):
    raise NativeDeadlineExpired('Native application-flow deadline exceeded')


if __name__ == '__main__':
    signal.signal(signal.SIGALRM, deadline)
    signal.signal(signal.SIGTERM, deadline)
    if sys.argv[1:] == ['--resume-owned-gateway']:
        signal.signal(signal.SIGINT, deadline)
        signal.alarm(2)
        sys.exit(0 if resume_owned_gateway() else 1)
    if len(sys.argv) != 1:
        sys.exit(2)
    signal.alarm(660)
    main()
