// Transport tests only: this controlled upstream is never native-app acceptance.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAppProxy } from './app_proxy.mjs';

const cert = readFileSync(process.env.NATIVE_TLS_CERT);
const key = readFileSync(process.env.NATIVE_TLS_KEY);

async function fixture(t, handler) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = createAppProxy({ cert, key }, upstream.address().port);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const open = (path, host = 'localhost:9443') => new Promise((resolve, reject) => {
    const request = https.get({ hostname: '127.0.0.1', port: proxy.address().port, path,
      servername: 'localhost', ca: cert, headers: { Host: host }, agent: false,
      signal: AbortSignal.timeout(4000) }, resolve);
    request.on('error', reject);
  });
  const healthy = async () => {
    const response = await open('/healthy');
    assert.equal(response.statusCode, 200);
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'healthy');
  };
  return { open, healthy };
}

test('upstream truncation aborts that HTTPS response and proxy still serves requests', { timeout: 10_000 }, async t => {
  let source;
  const { open, healthy } = await fixture(t, (request, response) => {
    if (request.url === '/healthy') { response.end('healthy'); return; }
    source = response;
    response.writeHead(200, { 'Content-Length': '100' });
    response.write('partial');
  });
  const response = await open('/truncated');
  response.on('error', () => {});
  const closed = new Promise(resolve => response.once('close', resolve));
  await once(response, 'data');
  source.destroy();
  await closed;
  assert.equal(response.complete, false);
  await healthy();
});

test('native-style SSE cancellation closes upstream exchange and preserves proxy', { timeout: 10_000 }, async t => {
  let upstreamClosed;
  const { open, healthy } = await fixture(t, (request, response) => {
    if (request.url === '/healthy') { response.end('healthy'); return; }
    assert.equal(request.headers.host, 'localhost:9443');
    assert.equal(request.headers['x-forwarded-proto'], 'https');
    upstreamClosed = once(response, 'close');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ready\n\n');
  });
  const response = await open('/events');
  response.on('error', () => {});
  await once(response, 'data');
  response.destroy();
  await upstreamClosed;
  await healthy();
});

test('unexpected TLS Host is rejected without reaching upstream', { timeout: 10_000 }, async t => {
  let reached = false;
  const { open } = await fixture(t, () => { reached = true; });
  const response = await open('/', 'outside.example');
  assert.equal(response.statusCode, 421);
  response.resume();
  await once(response, 'end');
  assert.equal(reached, false);
});
