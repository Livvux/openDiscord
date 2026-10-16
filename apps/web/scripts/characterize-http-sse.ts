import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { count, eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { applicationRateLimit, community, integration, member, message, streamLease, user } from "../src/db/schema";
import { auth } from "../src/lib/auth";
import { REGISTRATION_HEADER, registrationAttestation } from "../src/lib/registration-policy";
import { createCommunity } from "../src/server/communities";
import { createIntegration } from "../src/server/integrations";
import { hashRateLimitKey } from "../src/server/rate-limit-store";
import { getMinimumAge } from "../src/server/operator-policy";
import { SseFrames, summarize } from "./http-sse-metrics";

const origin = "http://localhost:3300";
const connection = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
if (process.env.GITHUB_ACTIONS !== "true" || process.env.OPENDISCORD_ISOLATED_LOAD !== "1"
  || !["localhost", "127.0.0.1"].includes(connection.hostname) || connection.pathname !== "/opendiscord"
  || process.env.BETTER_AUTH_URL !== origin) throw new Error("Requires explicitly enabled isolated CI database and matching loopback origin");

const ids: string[] = [];
const cookies: string[] = [];
const rateKeys: string[] = [];
const streams: ReturnType<typeof openStream>[] = [];
const controller = new AbortController();
const watchdog = setTimeout(() => controller.abort(), 120_000);
let communityId: string | undefined;
let server: ReturnType<typeof spawn> | undefined;
const report: Record<string, unknown> = {
  scope: "Single production-build process, real HTTP cookie-auth reads/SSE and bot-token-auth writes. Synthetic fixtures; excludes browsers, media, multi-replica capacity and production capacity/SLO claims.",
  source: process.env.GITHUB_SHA,
  environment: { node: process.version, platform: process.platform, logicalCpus: cpus().length, hostMemoryMiB: Math.round(totalmem() / 1048576), resourceMeasurement: "Host metadata only; application CPU/RSS not measured." },
  fixture: { readers: 20, history: 3000, historyRequests: 100, botWriters: 4, writes: 16, reconnectWrites: 1 },
  passed: false,
};
async function request(path: string, init: RequestInit = {}) {
  return fetch(`${origin}${path}`, { ...init, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!await check()) {
    controller.signal.throwIfAborted();
    assert.ok(performance.now() < deadline, "Timed out awaiting bounded harness condition");
    await delay(20, undefined, { signal: controller.signal });
  }
}
function openStream(cookie: string) {
  const abort = new AbortController();
  const received = new Map<string, number>();
  let ready = false;
  let failure: unknown;
  const task = (async () => {
    const response = await fetch(`${origin}/api/communities/${communityId}/events`, {
      headers: { cookie }, signal: AbortSignal.any([abort.signal, controller.signal]),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const frames = new SseFrames();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const frame of frames.push(decoder.decode(chunk.value, { stream: true }))) {
          if (frame.event === "ready") ready = true;
          if (frame.event === "message.created") {
            const data: unknown = JSON.parse(frame.data);
            assert.ok(typeof data === "object" && data !== null && "id" in data && typeof data.id === "string");
            assert.ok(!received.has(data.id), "Duplicate message event");
            received.set(data.id, performance.now());
          }
        }
      }
      assert.ok(abort.signal.aborted || controller.signal.aborted, "Unexpected SSE end");
    } finally { await reader.cancel(); reader.releaseLock(); }
  })().catch((error: unknown) => { if (!abort.signal.aborted && !controller.signal.aborted) failure = error; });
  return { received, abort, task, ready: () => { if (failure) throw failure; return ready; }, check: () => { if (failure) throw failure; } };
}

async function run() {
  try {
    // Supported Better Auth API creates real signed session cookies; never forge cookies or log credentials.
    for (let i = 0; i < 21; i++) {
      const signup = await auth.api.signUpEmail({
        headers: { [REGISTRATION_HEADER]: registrationAttestation(getMinimumAge()) },
        body: { name: "HTTP load fixture", email: `${randomUUID()}@example.test`, password: randomUUID() }, returnHeaders: true,
      });
      ids.push(signup.response.user.id);
      const cookie = signup.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      cookies.push(cookie);
    }
    const created = await createCommunity(ids[0], "HTTP SSE isolated fixture");
    communityId = created.communityId;
    await db.insert(member).values(ids.slice(1, 20).map((userId) => ({ userId, communityId: created.communityId })));
    for (let offset = 0; offset < 3000; offset += 500) await db.insert(message).values(Array.from({ length: 500 }, (_, i) => ({ channelId: created.channelId, authorId: ids[i % 20], content: `Synthetic history ${offset + i}` })));
    const bots = [];
    for (let i = 0; i < 4; i++) {
      const bot = await createIntegration(ids[0], communityId, { kind: "bot", name: "HTTP writer" });
      const row = await db.query.integration.findFirst({ where: eq(integration.id, bot.id) });
      assert.ok(row);
      ids.push(row.userId);
      rateKeys.push(hashRateLimitKey(`api:${bot.id}`));
      bots.push(bot);
    }
    await cp(".next/static", ".next/standalone/apps/web/.next/static", { recursive: true });
    await cp("public", ".next/standalone/apps/web/public", { recursive: true });
    server = spawn(process.execPath, [".next/standalone/apps/web/server.js"], { env: { ...process.env, PORT: "3300", HOSTNAME: "127.0.0.1" }, stdio: ["ignore", "ignore", "pipe"] });
    let serverStderrBytes = 0;
    server.stderr?.on("data", (chunk: Buffer) => { serverStderrBytes += chunk.length; report.serverStderrBytes = serverStderrBytes; });
    await until(async () => { assert.equal(server?.exitCode, null); return request("/api/ready").then((r) => r.status === 200).catch(() => false); });
    const readPath = `/api/channels/${created.channelId}/messages`;
    for (const path of [readPath, `/api/communities/${communityId}/events`]) {
      const denied = await request(path, { headers: { cookie: cookies[20] } });
      assert.equal(denied.status, 404); await denied.arrayBuffer();
    }
    for (const cookie of cookies.slice(0, 20)) streams.push(openStream(cookie));
    await until(() => streams.every((s) => s.ready()));
    const reads: number[] = [];
    let next = 0;
    const started = performance.now();
    await Promise.all(cookies.slice(0, 20).map(async (cookie) => {
      while (next++ < 100) {
        const start = performance.now();
        const response = await request(readPath, { headers: { cookie } });
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.equal(page.messages.length, 50); assert.equal(page.hasMore, true);
        assert.ok(page.messages.every((row: { channelId: string }) => row.channelId === created.channelId));
        reads.push(performance.now() - start);
      }
    }));
    const readDurationMs = performance.now() - started;
    const writes: number[] = [], fanout: number[] = [];
    const sent = new Set<string>();
    async function send(index: number) {
      const start = performance.now();
      const response = await request(`/api/v1/channels/${created.channelId}/messages`, {
        method: "POST", headers: { authorization: `Bearer ${bots[index % 4].token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: `HTTP synthetic write ${index}` }),
      });
      assert.equal(response.status, 201);
      const result = await response.json();
      assert.equal(typeof result.id, "string");
      writes.push(performance.now() - start); sent.add(result.id);
      return { id: result.id as string, start };
    }
    for (let i = 0; i < 16; i++) {
      const sentMessage = await send(i);
      await until(() => streams.every((s) => { s.check(); return s.received.has(sentMessage.id); }));
      for (const s of streams) fanout.push(s.received.get(sentMessage.id)! - sentMessage.start);
    }
    assert.ok(streams.every((s) => s.received.size === sent.size));
    streams[0].abort.abort(); await streams[0].task;
    const reconnectStart = performance.now();
    const reconnected = openStream(cookies[0]); streams.push(reconnected);
    await until(() => reconnected.ready());
    const reconnectReadyMs = performance.now() - reconnectStart;
    const sentinel = await send(16);
    await until(() => { reconnected.check(); return reconnected.received.has(sentinel.id); });
    await until(() => streams.slice(1, 20).every((s) => { s.check(); return s.received.has(sentinel.id); }));
    report.result = { reads: summarize(reads), readDurationMs, readRequestsPerSecond: reads.length * 1000 / readDurationMs,
      writes: summarize(writes), fanoutMs: summarize(fanout), fanoutReceipts: fanout.length, reconnectReadyMs,
      reconnectSentinelMs: reconnected.received.get(sentinel.id)! - sentinel.start, outsiderDenied: true, unexpectedErrors: 0 };
    report.passed = true;
  } finally {
    for (const stream of streams) stream.abort.abort();
    await Promise.all(streams.map((s) => s.task));
    try {
      if (ids.length) {
        await until(async () => { const [row] = await db.select({ n: count() }).from(streamLease).where(inArray(streamLease.userId, ids)); return row.n === 0; });
        report.streamLeasesAfterAbort = 0;
      }
    } finally {
      if (server) {
        server.kill("SIGTERM");
        await Promise.race([new Promise<void>((resolve) => server!.once("exit", () => resolve())), delay(5000)]);
        if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await new Promise<void>((resolve) => server!.once("exit", () => resolve())); }
      }
      if (rateKeys.length) await db.delete(applicationRateLimit).where(inArray(applicationRateLimit.key, rateKeys));
      if (communityId) await db.delete(community).where(eq(community.id, communityId));
      if (ids.length) await db.delete(user).where(inArray(user.id, ids));
      report.fixturesDeleted = true;
    }
  }
}
void run().catch(() => { report.passed = false; report.failure = "Harness assertion or bounded operation failed; credentials and payloads omitted."; process.exitCode = 1; }).finally(async () => {
  clearTimeout(watchdog);
  await writeFile("http-sse-characterization.json", `${JSON.stringify(report, null, 2)}\n`);
  await db.$client.end();
});
