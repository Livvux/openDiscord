// Loopback TLS transport for the unmodified production application; no fixture routes.
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function createAppProxy(tls, upstreamPort = 3200) {
  const server = https.createServer(tls, (request, response) => {
    if (request.headers.host !== 'localhost:9443') { response.writeHead(421).end(); return; }
    let incoming;
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: request.url,
      method: request.method,
      headers: { ...request.headers, host: 'localhost:9443', 'x-forwarded-proto': 'https' } });
    // Abort is per exchange. Never expose raw upstream errors or leave half a 200 response.
    const abort = () => {
      incoming?.destroy();
      upstream.destroy();
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    };
    upstream.on('error', abort);
    upstream.on('response', (value) => {
      incoming = value;
      incoming.on('error', abort);
      incoming.on('aborted', abort);
      if (response.destroyed) { incoming.destroy(); return; }
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    request.on('error', abort);
    request.on('aborted', abort);
    response.on('error', abort);
    response.on('close', () => {
      incoming?.destroy();
      upstream.destroy();
    });
    upstream.setTimeout(90_000, abort);
    request.pipe(upstream);
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createAppProxy({ key: readFileSync(process.env.NATIVE_TLS_KEY), cert: readFileSync(process.env.NATIVE_TLS_CERT) });
  server.listen(9443, 'localhost');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit());
  });
}
