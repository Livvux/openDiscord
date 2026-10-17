"""Exercise the real Linux Tauri WebView over trusted HTTPS, without IPC test grants."""
import base64
import http.server
import json
import os
import pathlib
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

from native_support import cleanup, has_complete_bytes, native_save_dialog

EVIDENCE = pathlib.Path('native-evidence')
EVIDENCE.mkdir(exist_ok=True)
save_diagnostics = {}


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/download', '/cancel'):
            body = b'OpenDiscord native download acceptance\n'
            self.send_response(200)
            filename = 'native-cancel.txt' if self.path == '/cancel' else 'native-proof.txt'
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
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
sandbox = tempfile.TemporaryDirectory(prefix='opendiscord-native-')
home = pathlib.Path(sandbox.name)
(home / 'Downloads').mkdir()
config = home / '.config'
config.mkdir()
(config / 'user-dirs.dirs').write_text('XDG_DOWNLOAD_DIR="$HOME/Downloads"\n')
driver = subprocess.Popen(['tauri-driver'], stdout=log, stderr=log,
                          env={**os.environ, 'HOME': str(home), 'XDG_CONFIG_HOME': str(config)})
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


def complete_download(path, expected, closed, diagnostic):
    exact = has_complete_bytes(path, expected, diagnostic.setdefault('download', {}))
    dialog_closed = closed()
    diagnostic['phase'] = 'complete' if exact and dialog_closed else 'await_file' if dialog_closed else 'await_closed'
    return exact and dialog_closed


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
    saved = home / 'proof.txt'
    blob_saved = home / 'blob.txt'
    cancelled = home / 'cancel.txt'
    default_cancelled = home / 'Downloads' / 'native-cancel.txt'
    # A download must display a native Save dialog before any bytes are written.
    save_diagnostics['http_download'] = {}
    saved_closed = native_save_dialog(saved,
        lambda: script("var a=document.createElement('a'); a.href='/download'; a.download='native-proof.txt'; document.body.append(a); a.click(); return true"),
        eventually, save_diagnostics['http_download'])
    eventually(lambda: complete_download(saved, b'OpenDiscord native download acceptance\n', saved_closed,
                                         save_diagnostics['http_download']), 'Download bytes incomplete or Save dialog still open')
    save_diagnostics['cancellation'] = {}
    cancelled_closed = native_save_dialog(cancelled,
        lambda: script("var a=document.createElement('a'); a.href='/cancel'; a.download='native-cancel.txt'; document.body.append(a); a.click(); return true"),
        eventually, save_diagnostics['cancellation'], cancel=True, also_absent=(default_cancelled,))
    eventually(cancelled_closed, 'Save cancellation failed')
    save_diagnostics['cancellation']['phase'] = 'complete'
    assert script('return document.readyState') == 'complete', 'WebView did not resume after cancellation'
    assert not cancelled.exists() and not default_cancelled.exists(), 'Cancelled transfer wrote a file'
    save_diagnostics['blob_download'] = {}
    blob_closed = native_save_dialog(blob_saved,
        lambda: script("var a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['native blob export'],{type:'application/octet-stream'})); a.download='native-blob.txt'; document.body.append(a); a.click(); return true"),
        eventually, save_diagnostics['blob_download'])
    eventually(lambda: complete_download(blob_saved, b'native blob export', blob_closed,
                                         save_diagnostics['blob_download']), 'Blob export bytes incomplete or Save dialog still open')
    # A subsequent completed transfer is a processing barrier for the prior cancellation.
    assert not cancelled.exists() and not default_cancelled.exists(), 'Cancelled transfer later wrote a file'
    (EVIDENCE / 'results.json').write_text(json.dumps({
        'https_launch': True, 'cross_origin_denied': True, 'file_scheme_denied': True,
        'native_ipc_denied': denial, 'native_save_download_bytes_verified': True, 'native_blob_export_bytes_verified': True, 'native_save_cancel': True,
        'scope': 'Linux fixture only; no application, macOS, Windows or physical-device parity claim'
    }, indent=2))
finally:
    try:
        (EVIDENCE / 'save-diagnostic.json').write_text(json.dumps(save_diagnostics, indent=2))
    finally:
        cleanup(lambda: command('DELETE', '') if session else None,
                driver, server, log, sys.exception(), sandbox.cleanup)
