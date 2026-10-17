// CI-only real DB/SDK acceptance after LiveKit starts; no media/browser acceptance claim.
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type ClientRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { RoomServiceClient } from "livekit-server-sdk";
import { db } from "../src/db";
import { channel, community, user } from "../src/db/schema";
import { voiceCall, voiceSfuRoom } from "../src/db/voice-schema";
import { voiceRoomName } from "../src/lib/voice/room";

const execute = promisify(execFile);
async function main() {
  let ownerId: string | undefined, communityId: string | undefined, roomName: string | undefined;
  let client: RoomServiceClient | undefined;
  let crashedChild: ChildProcess | undefined, crashedExit: Promise<NodeJS.Signals | null> | undefined;
  let stopProxy: (() => Promise<void>) | undefined;
  try {
    const database = new URL(process.env.DATABASE_URL!);
    assert(process.env.CI === "true" && database.hostname === "localhost" && database.pathname === "/opendiscord");
    assert(process.env.LIVEKIT_URL === "ws://localhost:7880");
    client = new RoomServiceClient("http://localhost:7880", process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, { requestTimeout: 2, failover: false });
    ownerId = randomUUID();
    await db.insert(user).values({ id: ownerId, name: "CI Voice repair", email: `${ownerId}@example.test` });
    const [group] = await db.insert(community).values({ ownerId, name: "CI Voice repair" }).returning();
    communityId = group.id;
    // An unrelated exact retired room lets a real worker claim it without touching product calls.
    roomName = voiceRoomName({ channelId: randomUUID(), callId: randomUUID(), generation: 1 });
    let ready = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await client.listRooms([roomName]); ready = true; break; }
      catch { await setTimeout(250); }
    }
    assert(ready, "isolated LiveKit must be ready before acceptance");
    await client.createRoom({ name: roomName });
    assert.equal((await client.listRooms([roomName])).length, 1);
    const parts = roomName.split(":");
    await db.insert(voiceSfuRoom).values({ roomName, channelId: parts[1], callId: parts[2], generation: 1, status: "retired", retiredAt: new Date(), lastAppTokenExpiry: new Date(),
      nextAttemptAt: new Date(0) });
    const fixtureRoom = roomName;
    let observedDelete: (() => void) | undefined;
    const observed = new Promise<void>(resolve => { observedDelete = resolve; });
    const upstreams = new Set<ClientRequest>();
    // Only this CI child's SDK requests enter this loopback proxy. Never log bodies/headers.
    const proxy = createServer((incoming, outgoing) => {
      void (async () => {
        assert.equal(incoming.method, "POST");
        assert(incoming.url?.startsWith("/twirp/livekit.RoomService/"));
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          assert(bytes <= 4096);
          chunks.push(buffer);
        }
        const body = Buffer.concat(chunks);
        if (incoming.url === "/twirp/livekit.RoomService/DeleteRoom" && JSON.parse(body.toString()).room === fixtureRoom) {
          // Receipt is after durable claim commit. Kill immediately, before the SDK timeout can settle the claim.
          assert(crashedChild?.kill("SIGKILL"));
          observedDelete?.();
          return; // Hold the request: neither forward deletion nor fabricate an SDK response.
        }
        const upstream = httpRequest({ hostname: "127.0.0.1", port: 7880, method: "POST", path: incoming.url,
          headers: { ...incoming.headers, host: "127.0.0.1:7880" }, timeout: 2000 }, response => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.on("error", () => outgoing.destroy());
          response.pipe(outgoing);
        });
        upstreams.add(upstream);
        upstream.on("close", () => upstreams.delete(upstream));
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => outgoing.destroy());
        upstream.end(body);
      })().catch(() => outgoing.destroy());
    });
    stopProxy = async () => {
      for (const upstream of upstreams) upstream.destroy();
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    };
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address();
    assert(address && typeof address !== "string");
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/voice-maintenance.ts", "--apply"], {
      stdio: "ignore", timeout: 15_000, killSignal: "SIGKILL",
      env: { ...process.env, LIVEKIT_API_URL: `http://127.0.0.1:${address.port}`, PGOPTIONS: "-c statement_timeout=15000 -c lock_timeout=2000" },
    });
    crashedChild = child;
    crashedExit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (_code, signal) => resolve(signal));
    });
    let observationTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      await Promise.race([observed, crashedExit.then(() => { throw new Error("Worker exited before the owned delete barrier"); }), new Promise<never>((_resolve, reject) => {
        observationTimer = globalThis.setTimeout(() => reject(new Error("Expected owned SDK delete before deadline")), 10_000);
      })]);
      assert.equal(await crashedExit, "SIGKILL");
    } finally { globalThis.clearTimeout(observationTimer); }
    await stopProxy(); stopProxy = undefined;
    const [claimed] = await db.select().from(voiceSfuRoom).where(eq(voiceSfuRoom.roomName, fixtureRoom));
    assert(claimed.leaseToken && claimed.leaseUntil && claimed.leaseUntil.getTime() > Date.now());
    assert.equal(claimed.lastOutcome, "pending");
    assert.equal(claimed.attempts, 1);
    assert.equal((await client.listRooms([fixtureRoom])).length, 1, "SIGKILL cannot delete the held exact SFU room");
    // Create bounded-call fixtures only after the real crashed worker has stopped.
    const channels = await db.insert(channel).values(Array.from({ length: 9 }, (_, index) => ({ communityId: group.id, name: `repair-${index}`, kind: "voice" as const }))).returning();
    const calls = await db.insert(voiceCall).values(channels.map(row => ({ channelId: row.id }))).returning();
    const invoke = async (args: string[]) => {
      const { stdout } = await execute(process.execPath, ["--import", "tsx", "scripts/voice-maintenance.ts", ...args], { timeout: 30_000, killSignal: "SIGKILL",
        env: { ...process.env, LIVEKIT_API_URL: "http://127.0.0.1:7880", PGOPTIONS: "-c statement_timeout=15000 -c lock_timeout=2000" } });
      const result = JSON.parse(stdout);
      assert.equal("closedCallIds" in result, false);
      assert.equal(result.rooms.failed, 0); assert.equal(result.rooms.unavailable, 0);
      return result;
    };
    const dry = await invoke([]);
    assert(dry.scanned >= 9); assert.equal(dry.closed, 0);
    const first = await invoke(["--apply"]);
    assert.equal(first.scanned, 8); assert.equal(first.closed, 8); assert.equal(first.limited, true);
    assert.equal((await client.listRooms([roomName])).length, 1, "a live worker lease is preserved");
    const next = await invoke(["--apply"]);
    assert.equal(next.scanned, 1); assert.equal(next.closed, 1); assert.equal(next.limited, false);
    assert(Date.now() < claimed.leaseUntil.getTime(), "bounded normal invocations must finish before the real lease expires");
    const [stillClaimed] = await db.select().from(voiceSfuRoom).where(eq(voiceSfuRoom.roomName, fixtureRoom));
    assert.equal(stillClaimed.leaseToken, claimed.leaseToken);
    assert.equal(stillClaimed.leaseUntil?.getTime(), claimed.leaseUntil.getTime());
    assert.equal(stillClaimed.attempts, 1);
    assert.equal((await client.listRooms([fixtureRoom])).length, 1, "normal workers cannot steal the actual unexpired crash lease");
    const remaining = claimed.leaseUntil.getTime() - Date.now();
    assert(remaining > 0 && remaining <= 30_000);
    await setTimeout(remaining + 150);
    const recovered = await invoke(["--apply"]);
    assert.equal(recovered.scanned, 0); assert(recovered.rooms.deleted >= 1);
    assert.equal((await client.listRooms([fixtureRoom])).length, 0, "actual exact-room SDK deletion after natural crash-lease expiry");
    const [repaired] = await db.select().from(voiceSfuRoom).where(eq(voiceSfuRoom.roomName, fixtureRoom));
    assert.equal(repaired.leaseToken, null); assert.equal(repaired.leaseUntil, null);
    assert.equal(repaired.attempts, 2); assert.equal(repaired.lastOutcome, "deleted");
    for (const call of calls) assert.equal((await db.select().from(voiceCall).where(eq(voiceCall.id, call.id)))[0].status, "closed");
    const empty = await invoke(["--apply"]);
    assert.equal(empty.scanned, 0);
    console.log("Voice maintenance real DB/SDK acceptance passed: bounded batches, actual SIGKILL worker crash, natural 30s lease recovery, exact-room delete, natural CLI exit/pool closure.");
  } finally {
    if (crashedChild && crashedChild.exitCode === null && crashedChild.signalCode === null) crashedChild.kill("SIGKILL");
    await crashedExit?.catch(() => {});
    await stopProxy?.();
    if (roomName) { await client?.deleteRoom(roomName).catch(() => {}); await db.delete(voiceSfuRoom).where(eq(voiceSfuRoom.roomName, roomName)); }
    if (communityId) await db.delete(community).where(eq(community.id, communityId));
    if (ownerId) await db.delete(user).where(eq(user.id, ownerId));
    await db.$client.end();
  }
}
void main().catch(() => { console.error("Voice maintenance CI acceptance failed; raw SDK and database errors withheld."); process.exitCode = 1; });
