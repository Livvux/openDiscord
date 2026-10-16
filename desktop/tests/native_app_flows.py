"""Real Linux Tauri/WebKit acceptance against the isolated production HTTPS app.

No browser replacement, native grants, crypto mocks or test application pages.
Artifacts intentionally contain only step outcomes and sanitized platform metadata.
"""
import base64
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
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
        results[name] = {'status': 'passed', 'seconds': round(time.monotonic() - started, 2)}
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
        self.port = 4444 + index * 2
        self.session = None
        self.home = sandbox / str(index)
        for directory in ['Downloads', '.config', '.local/share', '.cache']:
            (self.home / directory).mkdir(parents=True, exist_ok=True)
        (self.home / '.config/user-dirs.dirs').write_text('XDG_DOWNLOAD_DIR="$HOME/Downloads"\n')
        self.log = tempfile.TemporaryFile()
        self.process = subprocess.Popen(['tauri-driver', '--port', str(self.port), '--native-port', str(self.port + 1)],
            stdout=self.log, stderr=self.log, start_new_session=True,
            env={**os.environ, 'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.home / '.config'),
                 'XDG_DATA_HOME': str(self.home / '.local/share'), 'XDG_CACHE_HOME': str(self.home / '.cache')})

    def request(self, method, path, body=None):
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}' + path,
            json.dumps(body).encode() if body is not None else None,
            {'Content-Type': 'application/json'}, method=method)
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.load(response)['value']

    def start(self):
        wait(lambda: self.request('GET', '/status'))
        value = self.request('POST', '/session', {'capabilities': {'alwaysMatch': {
            'tauri:options': {'application': str(ROOT / 'target/debug/opendiscord-desktop')}}}})
        self.session = value['sessionId']
        self.command('POST', '/timeouts', {'script': 60000, 'pageLoad': 60000, 'implicit': 0})
        self.goto('/sign-in')

    def command(self, method, path, body=None):
        return self.request(method, '/session/' + self.session + path, body)

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

    def screenshot(self, name):
        (EVIDENCE / (name + '.png')).write_bytes(base64.b64decode(self.command('GET', '/screenshot')))

    def signup(self, name):
        email = name.lower().replace(' ', '-') + '@example.test'
        self.goto('/sign-up')
        self.fill('Display name', name)
        self.fill('Email', email)
        self.fill('Password', 'native acceptance disposable password')
        checkbox = self.element('//button[@role="checkbox"] | //input[@type="checkbox"]')
        self.command('POST', '/element/' + checkbox + '/click', {})
        self.click('Create account')
        wait(lambda: '/app' in self.command('GET', '/url'))
        return email

    def login(self, email):
        self.goto('/sign-in?next=/app/messages')
        self.fill('Email', email)
        self.fill('Password', 'native acceptance disposable password')
        self.click('Sign in')
        wait(lambda: self.command('GET', '/url').endswith('/app/messages'))

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

    def close(self):
        try:
            if self.session:
                self.command('DELETE', '')
        finally:
            # Driver exit alone does not prove its WebKit/application children exited.
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=5)
            self.log.close()


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
                alice.goto('/app/settings')
                alice.click('Sign out')
                wait(lambda: '/sign-in' in alice.command('GET', '/url'))
                alice.login(email)
            with stage('community_navigation'):
                alice.goto('/app')
                alice.click('Create a community')
                alice.fill('Name', 'Native Acceptance Community')
                alice.click('Create')
                wait(lambda: alice.text('general'))
                community_path = urllib.parse.urlsplit(alice.command('GET', '/url')).path
                alice.click('Invite people')
                alice.click('Create invite link')
                invite = wait(lambda: alice.script('return document.querySelector("input[readonly]")?.value'))
                bob.goto(urllib.parse.urlsplit(invite).path)
                bob.click('Accept invite')
                wait(lambda: bob.text('general'))
                alice.goto(community_path)
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
                data = json.loads(exported.read_text())
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
                wait(lambda: '/sign-in' in bob.command('GET', '/url'))
                bob.goto('/app/messages')
                wait(lambda: '/sign-in' in bob.command('GET', '/url'))
            with stage('runtime_errors'):
                unavailable = 0
                for client in clients:
                    try:
                        logs = client.command('POST', '/log', {'type': 'browser'})
                    except urllib.error.HTTPError as error:
                        assert error.code in [404, 405, 500]
                        unavailable += 1
                    else:
                        assert not any(entry.get('level') == 'SEVERE' for entry in logs)
                metadata['console_endpoint_unavailable_profiles'] = unavailable
        finally:
            errors = []
            for client in reversed(clients):
                try:
                    client.close()
                except Exception as error:
                    errors.append(type(error).__name__)
            metadata['cleanup_errors'] = errors
            persist()
            if errors:
                raise RuntimeError('Owned native process cleanup failed')


def deadline(_signal, _frame):
    raise TimeoutError('Native application-flow deadline exceeded')


if __name__ == '__main__':
    signal.signal(signal.SIGALRM, deadline)
    signal.signal(signal.SIGTERM, deadline)
    signal.alarm(660)
    main()
