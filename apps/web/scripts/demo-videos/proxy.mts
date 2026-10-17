// TLS front for the local build: `.app` is HSTS-preloaded, so https://opendiscord.app (mapped to this proxy by the
// browser's host-resolver rule) is the only way to show a production-looking host in the video. Self-signed, test only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PROXY_PORT = 8443;
const UPSTREAM_PORT = 3300;

export function startProxy(): Promise<() => Promise<void>> {
  const dir = mkdtempSync(join(tmpdir(), "od-proxy-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=opendiscord.app",
    "-addext", "subjectAltName=DNS:opendiscord.app", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
  const server = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
    const up = http.request({ host: "127.0.0.1", port: UPSTREAM_PORT, method: req.method, path: req.url,
      headers: { ...req.headers, "x-forwarded-proto": "https" } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.statusCode = 502; res.end(); });
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, "127.0.0.1", () => resolve(() => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }))));
}
