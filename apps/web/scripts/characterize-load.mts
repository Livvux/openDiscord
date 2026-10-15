import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db/index";
import { community, member, message, user } from "../src/db/schema";
import { createCommunity } from "../src/server/communities";
import { AppError } from "../src/server/errors";
import { listMessages, PAGE_SIZE } from "../src/server/messages";

const connection = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
if (process.env.GITHUB_ACTIONS !== "true" || process.env.OPENDISCORD_ISOLATED_LOAD !== "1"
  || !["localhost", "127.0.0.1"].includes(connection.hostname) || connection.pathname !== "/opendiscord") {
  throw new Error("Load characterization requires the explicitly enabled isolated GitHub CI database.");
}

const readers = 20;
const requests = 100;
const history = 3000;
const ids = Array.from({ length: readers + 2 }, () => randomUUID());
let communityId: string | undefined;

try {
  await db.insert(user).values(ids.map((id) => ({ id, name: "Synthetic load reader", email: `${id}@example.test` })));
  const created = await createCommunity(ids[0], "Isolated load characterization");
  communityId = created.communityId;
  await db.insert(member).values(ids.slice(1, readers + 1).map((userId) => ({ userId, communityId: created.communityId })));
  for (let offset = 0; offset < history; offset += 500) {
    await db.insert(message).values(Array.from({ length: 500 }, (_, index) => ({
      channelId: created.channelId, authorId: ids[(offset + index) % readers], content: `Synthetic history ${offset + index}`,
    })));
  }
  await assert.rejects(listMessages(ids.at(-1)!, created.channelId), (error: unknown) => error instanceof AppError && error.code === "not_found");
  const validate = async (reader: number) => {
    const result = await listMessages(ids[reader], created.channelId);
    assert.equal(result.messages.length, PAGE_SIZE);
    assert.equal(result.hasMore, true);
    assert.ok(result.messages.every((row) => row.channelId === created.channelId && row.content.startsWith("Synthetic history ")));
  };
  for (let index = 0; index < 5; index++) await validate(index);
  const latencies: number[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: readers }, async (_, reader) => {
    while (next++ < requests) {
      const start = performance.now();
      await validate(reader);
      latencies.push(performance.now() - start);
    }
  }));
  const durationMs = performance.now() - started;
  assert.equal(latencies.length, requests);
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) => Math.round(latencies[Math.ceil(p * latencies.length) - 1] * 100) / 100;
  const report = {
    scope: "Permission-checked message service; excludes HTTP, SSE and media. Not a production capacity estimate.",
    environment: { node: process.version, platform: process.platform, architecture: process.arch, logicalCpus: cpus().length, memoryMiB: Math.round(totalmem() / 1048576) },
    fixture: { readers, messages: history, returnedPageSize: PAGE_SIZE },
    result: { requests, concurrency: readers, durationMs: Math.round(durationMs), requestsPerSecond: Math.round(requests * 1000 / durationMs * 100) / 100, latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: percentile(1) }, outsiderDenied: true },
  };
  const output = JSON.stringify(report, null, 2);
  await writeFile("load-characterization.json", `${output}\n`);
  console.log(output);
} finally {
  try {
    if (communityId) await db.delete(community).where(eq(community.id, communityId));
    await db.delete(user).where(inArray(user.id, ids));
  } finally {
    await db.$client.end();
  }
}
