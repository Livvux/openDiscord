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
EVIDENCE = ROOT / 'native-app-evidence'
EVIDENCE.mkdir(exist_ok=True)
CASES = ['native_profile_capabilities', 'signup_login', 'community_navigation',
         'private_attachment', 'community_export', 'dm_enrollment', 'dm_sas_delivery',
         'dm_persistence', 'dm_recovery', 'logout', 'runtime_errors']
results = {name: {'status': 'not-run'} for name in CASES}
metadata = {'sha': os.environ.get('GITHUB_SHA'), 'scope': 'Linux native production app only',
            'console_capture': 'WebDriver console endpoint probed; absence reported explicitly'}


class NativeDeadlineExpired(Exception):
    """Global expiry must never be mistaken for a retryable socket OSError."""


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

    def prefix_click(self, prefix):
        identifier = self.element(f'//button[starts-with(normalize-space(.),{json.dumps(prefix)})]')
        wait(lambda: self.command('GET', '/element/' + identifier + '/enabled'))
        self.command('POST', '/element/' + identifier + '/click', {})

    def fill(self, label, value):
        identifier = self.element(f'//*[self::input or self::textarea][@id=//label[normalize-space(.)={json.dumps(label)}]/@for]'
            f' | //label[starts-with(normalize-space(.),{json.dumps(label)})]//input'
            f' | //textarea[@aria-label={json.dumps(label)}]')
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
              const protectedContent = arguments[0] === '/app'
                ? Array.from(document.querySelectorAll('main section button')).some(node => visible(node) && node.textContent.trim() === 'Create a community')
                : Array.from(document.querySelectorAll('aside[aria-label="Direct conversations"]')).some(visible);
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

    def upload(self, xpath, path):
        identifier = self.element(xpath)
        self.command('POST', '/element/' + identifier + '/value', {'text': str(path)})

    def save(self, destination):
        def dialog():
            found = subprocess.run(['xdotool', 'search', '--name', '^Save OpenDiscord download$'], capture_output=True, check=False)
            return found.stdout.decode().splitlines() if found.returncode == 0 else None
        windows = wait(dialog)
        subprocess.run(['xdotool', 'windowfocus', '--sync', windows[-1]], check=True, timeout=5)
        assert not destination.exists()
        subprocess.run(['xdotool', 'key', 'ctrl+a'], check=True, timeout=5)
        subprocess.run(['xdotool', 'type', '--clearmodifiers', str(destination)], check=True, timeout=5)
        subprocess.run(['xdotool', 'key', 'Return'], check=True, timeout=5)
        wait(lambda: destination.exists() and destination.stat().st_size > 0)
        wait(lambda: not dialog())

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
             'refresh': 'refresh', 'screenshot': 'screenshot', 'log': 'console_log'}
    if len(suffix) == 1:
        return fixed.get(suffix[0], 'other')
    if suffix == ['execute', 'sync']:
        return 'sync_script'
    if suffix == ['execute', 'async']:
        return 'async_script'
    if len(suffix) >= 3 and suffix[0] == 'element':
        return {'click': 'element_click', 'value': 'element_input', 'displayed': 'element_displayed',
                'enabled': 'element_enabled', 'attribute': 'element_attribute'}.get(suffix[2], 'other')
    return 'other'


AUTH_ACTIONS = {
    'open_signup', 'fill_display_name', 'fill_signup_email', 'fill_signup_password',
    'confirm_registration_policy', 'submit_signup', 'await_signup_navigation',
    'open_login', 'fill_login_email', 'fill_login_password', 'submit_login',
    'await_login_navigation', 'open_account_settings', 'sign_out', 'await_signout_navigation',
}


def auth_progress(profile, action):
    if profile not in {0, 1, 2} or action not in AUTH_ACTIONS:
        raise ValueError('Auth diagnostic action is not allowlisted')
    metadata['auth_action'] = {'profile': profile, 'action': action}
    persist()


def at_app_path(url, path):
    actual = urllib.parse.urlsplit(url)
    expected = urllib.parse.urlsplit(ORIGIN + path)
    return (actual.scheme, actual.netloc, actual.path) == (expected.scheme, expected.netloc, expected.path)


def auth_destination_reached(snapshot, path):
    return snapshot['protected_content'] is True and at_app_path(snapshot['url'], path)


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


def failure_diagnostics(clients, budget=10):
    """Called inside the existing global diagnostic timer, sharing its total budget."""
    deadline_at = time.monotonic() + budget
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
    with tempfile.TemporaryDirectory(prefix='native-app-flows-') as directory:
        sandbox = pathlib.Path(directory)
        try:
            with stage('native_profile_capabilities'):
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
                wait(lambda: at_app_path(alice.command('GET', '/url'), '/sign-in'))
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
                bob.command('POST', '/element/' + identifier + '/click', {})
                downloaded = sandbox / 'attachment.txt'
                bob.save(downloaded)
                wait(lambda: downloaded.read_bytes() == payload)
                metadata['attachment'] = {'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload), 'outsider_status': status}
            with stage('community_export'):
                alice.click('Community settings', 'a')
                alice.click('Download community export', 'a')
                exported = sandbox / 'community.json'
                alice.save(exported)
                data = complete_json(exported, export_shape)
                assert data['format'] == 'opendiscord.community-export'
                assert len(data['messages']) >= 1
            with stage('dm_enrollment'):
                # Post a community message from Bob, then use the actual private-message link.
                bob.goto(community_path)
                composer = bob.element('//textarea[@id=//label[starts-with(normalize-space(.),"Message #")]/@for]')
                bob.command('POST', '/element/' + composer + '/value', {'text': 'Native community greeting'})
                bob.click('Send message')
                alice.goto(community_path)
                alice.click('Message Native Bob privately', 'a')
                alice.click('Send message request')
                bob.goto('/app/messages')
                bob.prefix_click('Native Alice')
                bob.click('Accept message request')
                wait(lambda: alice.text('Verify device'))
                send = alice.element('//button[normalize-space(.)="Send encrypted message"]')
                assert not alice.command('GET', '/element/' + send + '/enabled')
            with stage('dm_sas_delivery'):
                alice.prefix_click('Verify device ')
                bob.click('Accept verification')
                alice.click('Show verification numbers')
                code_a = wait(lambda: alice.script('return document.querySelector("[data-verification-code]")?.textContent'))
                code_b = wait(lambda: bob.script('return document.querySelector("[data-verification-code]")?.textContent'))
                assert code_a == code_b
                del code_a, code_b
                alice.click('The numbers match')
                bob.click('The numbers match')
                secret_message = 'Disposable native encrypted delivery 73192'
                alice.fill('Encrypted message', secret_message)
                alice.click('Send encrypted message')
                wait(lambda: bob.text(secret_message), 60)
                safe_transport = alice.async_script('''const done=arguments[arguments.length-1], text=arguments[0];
                  fetch('/api/dm').then(r=>r.json()).then(async r=>{const id=r.conversations[0].id;const response=await fetch('/api/dm?conversation='+encodeURIComponent(id));done(response.ok && !(await response.text()).includes(text));}).catch(()=>done(false));''', secret_message)
                assert safe_transport
            with stage('dm_persistence'):
                bob.command('POST', '/refresh', {})
                bob.prefix_click('Native Alice')
                wait(lambda: bob.text(secret_message), 60)
            with stage('dm_recovery'):
                if not alice.text('Create encrypted recovery backup'):
                    alice.click('Devices and recovery')
                alice.click('Create encrypted recovery backup')
                alice.click('Download your private recovery file', 'a')
                recovery = sandbox / 'recovery.json'
                alice.save(recovery)
                complete_json(recovery, recovery_shape)
                recovered.login(email)
                recovered.click('Devices and recovery')
                recovered.upload('//label[starts-with(normalize-space(.),"Open encrypted recovery archive")]//input', recovery)
                summary = recovered.element('//summary[starts-with(normalize-space(.),"View recovered archive")]')
                recovered.command('POST', '/element/' + summary + '/click', {})
                wait(lambda: recovered.text(secret_message), 60)
                recovered.command('POST', '/refresh', {})
                summary = recovered.element('//summary[starts-with(normalize-space(.),"View recovered archive")]')
                recovered.command('POST', '/element/' + summary + '/click', {})
                wait(lambda: recovered.text(secret_message), 60)
                recovery.unlink()
            with stage('logout'):
                bob.goto('/app/settings')
                bob.click('Sign out')
                wait(lambda: at_app_path(bob.command('GET', '/url'), '/sign-in'))
                bob.goto('/app/messages')
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
            if primary_error is not None:
                signal.setitimer(signal.ITIMER_REAL, 10)
                try:
                    failure_diagnostics(clients)
                except Exception as error:
                    metadata['transport_diagnostic_error_type'] = type(error).__name__
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
            errors = cleanup_clients(list(reversed(clients)))
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
    signal.alarm(660)
    main()
