// Loopback TLS transport for the unmodified production application; no fixture routes.
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
const server = https.createServer({ key: readFileSync(process.env.NATIVE_TLS_KEY), cert: readFileSync(process.env.NATIVE_TLS_CERT) }, (request, response) => {
  if (request.headers.host !== 'localhost:9443') { response.writeHead(421).end(); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: 3200, path: request.url, method: request.method,
    headers: { ...request.headers, host: 'localhost:9443', 'x-forwarded-proto': 'https' } }, (incoming) => {
    response.writeHead(incoming.statusCode, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
});
server.on('upgrade', (_request, socket) => socket.destroy());
server.listen(9443, 'localhost');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit()); });
