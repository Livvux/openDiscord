"""Exercise the real Linux Tauri WebView over trusted HTTPS, without IPC test grants."""
import base64
import http.server
import json
import pathlib
import ssl
import subprocess
import threading
import time
import urllib.request

EVIDENCE = pathlib.Path('native-evidence')
EVIDENCE.mkdir(exist_ok=True)


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/download':
            body = b'OpenDiscord native download acceptance\n'
            self.send_response(200)
            self.send_header('Content-Disposition', 'attachment; filename="native-proof.txt"')
            self.send_header('Content-Type', 'text/plain')
        else:
            body = b'<html><title>Native HTTPS fixture</title><body><h1>OpenDiscord native fixture</h1></body></html>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


server = http.server.ThreadingHTTPServer(('localhost', 9443), Fixture)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('/tmp/desktop-fixture.crt', '/tmp/desktop-fixture.key')
server.socket = context.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
log = (EVIDENCE / 'driver.log').open('w')
driver = subprocess.Popen(['tauri-driver'], stdout=log, stderr=log)
session = None


def request(method, path, body=None):
    encoded = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request('http://localhost:4444' + path, encoded,
                                 {'Content-Type': 'application/json'}, method=method)
    with urllib.request.urlopen(req, timeout=40) as response:
        return json.load(response)['value']


def command(method, path, body=None):
    return request(method, '/session/' + session + path, body)


def script(source):
    return command('POST', '/execute/sync', {'script': source, 'args': []})


def eventually(check, message):
    for _ in range(60):
        if check():
            return
        time.sleep(0.5)
    raise AssertionError(message)


try:
    for _ in range(60):
        try:
            request('GET', '/status')
            break
        except (OSError, ValueError):
            time.sleep(0.5)
    value = request('POST', '/session', {'capabilities': {'alwaysMatch': {
        'tauri:options': {'application': str(pathlib.Path('target/debug/opendiscord-desktop').resolve())}
    }}})
    session = value['sessionId']
    eventually(lambda: command('GET', '/title') == 'Native HTTPS fixture', 'HTTPS fixture did not load')
    script("window.location.href='https://example.com/'; return true")
    time.sleep(1)
    assert command('GET', '/url').startswith('https://localhost:9443'), 'Origin escaped'
    script("window.location.href='file:///etc/passwd'; return true")
    time.sleep(1)
    assert command('GET', '/url').startswith('https://localhost:9443'), 'Local scheme escaped'
    script("window.ipcResult='pending'; window.__TAURI_INTERNALS__.invoke('plugin:window|close', {label:'main'}).then(()=>window.ipcResult='allowed', e=>window.ipcResult=String(e)); return true")
    eventually(lambda: script('return window.ipcResult') != 'pending', 'IPC did not resolve')
    denial = script('return window.ipcResult')
    assert 'not allowed' in denial.lower() or 'denied' in denial.lower(), denial
    screenshot = command('GET', '/screenshot')
    (EVIDENCE / 'linux-webview.png').write_bytes(base64.b64decode(screenshot))
    # A download must display a native Save dialog before any bytes are written.
    script("var a=document.createElement('a'); a.href='/download'; a.download='native-proof.txt'; document.body.append(a); a.click(); return true")
    eventually(lambda: subprocess.run(['xdotool', 'search', '--name', 'Save OpenDiscord download'], capture_output=True).returncode == 0, 'Save dialog absent')
    subprocess.run(['xdotool', 'key', 'ctrl+a'], check=True)
    subprocess.run(['xdotool', 'type', '/tmp/opendiscord-native-proof.txt'], check=True)
    subprocess.run(['xdotool', 'key', 'Return'], check=True)
    saved = pathlib.Path('/tmp/opendiscord-native-proof.txt')
    eventually(saved.exists, 'Download not saved')
    assert saved.read_bytes() == b'OpenDiscord native download acceptance\n'
    script("var a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['native blob export'],{type:'application/octet-stream'})); a.download='native-blob.txt'; document.body.append(a); a.click(); return true")
    eventually(lambda: subprocess.run(['xdotool', 'search', '--name', 'Save OpenDiscord download'], capture_output=True).returncode == 0, 'Blob Save dialog absent')
    subprocess.run(['xdotool', 'key', 'ctrl+a'], check=True)
    subprocess.run(['xdotool', 'type', '/tmp/opendiscord-native-blob.txt'], check=True)
    subprocess.run(['xdotool', 'key', 'Return'], check=True)
    blob_saved = pathlib.Path('/tmp/opendiscord-native-blob.txt')
    eventually(blob_saved.exists, 'Blob export not saved')
    assert blob_saved.read_bytes() == b'native blob export'
    (EVIDENCE / 'results.json').write_text(json.dumps({
        'https_launch': True, 'cross_origin_denied': True, 'file_scheme_denied': True,
        'native_ipc_denied': denial, 'native_save_download_bytes_verified': True, 'native_blob_export_bytes_verified': True,
        'scope': 'Linux fixture only; no application, macOS, Windows or physical-device parity claim'
    }, indent=2))
finally:
    if session:
        command('DELETE', '')
    driver.terminate()
    server.shutdown()
