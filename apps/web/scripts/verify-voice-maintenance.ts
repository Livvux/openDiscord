// CI-only real DB/SDK acceptance after LiveKit starts; no media/browser acceptance claim.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  try {
    const database = new URL(process.env.DATABASE_URL!);
    assert(process.env.CI === "true" && database.hostname === "localhost" && database.pathname === "/opendiscord");
    assert(process.env.LIVEKIT_URL === "ws://localhost:7880");
    client = new RoomServiceClient("http://localhost:7880", process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, { requestTimeout: 2, failover: false });
    ownerId = randomUUID();
    await db.insert(user).values({ id: ownerId, name: "CI Voice repair", email: `${ownerId}@example.test` });
    const [group] = await db.insert(community).values({ ownerId, name: "CI Voice repair" }).returning();
    communityId = group.id;
    const channels = await db.insert(channel).values(Array.from({ length: 9 }, (_, index) => ({ communityId: group.id, name: `repair-${index}`, kind: "voice" as const }))).returning();
    const calls = await db.insert(voiceCall).values(channels.map(row => ({ channelId: row.id }))).returning();
    // An unrelated old retired room represents a crashed worker, with its lease still live.
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
      nextAttemptAt: new Date(0), leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) });
    const invoke = async (args: string[]) => {
      const { stdout } = await execute(process.execPath, ["--import", "tsx", "scripts/voice-maintenance.ts", ...args], { timeout: 30_000,
        env: { ...process.env, PGOPTIONS: "-c statement_timeout=15000 -c lock_timeout=2000" } });
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
    // Only the CI fixture lease expires; the runner itself never overrides durable leases.
    await db.update(voiceSfuRoom).set({ leaseUntil: new Date(Date.now() + 50) }).where(eq(voiceSfuRoom.roomName, roomName));
    await setTimeout(100);
    const next = await invoke(["--apply"]);
    assert.equal(next.scanned, 1); assert.equal(next.closed, 1); assert.equal(next.limited, false);
    assert(next.rooms.deleted >= 1);
    assert.equal((await client.listRooms([roomName])).length, 0, "actual exact-room SDK delete after crash lease recovery");
    for (const call of calls) assert.equal((await db.select().from(voiceCall).where(eq(voiceCall.id, call.id)))[0].status, "closed");
    const empty = await invoke(["--apply"]);
    assert.equal(empty.scanned, 0);
    console.log("Voice maintenance real DB/SDK acceptance passed: bounded batches, lease recovery, exact-room delete, natural CLI exit/pool closure.");
  } finally {
    if (roomName) { await client?.deleteRoom(roomName).catch(() => {}); await db.delete(voiceSfuRoom).where(eq(voiceSfuRoom.roomName, roomName)); }
    if (communityId) await db.delete(community).where(eq(community.id, communityId));
    if (ownerId) await db.delete(user).where(eq(user.id, ownerId));
    await db.$client.end();
  }
}
void main().catch(() => { console.error("Voice maintenance CI acceptance failed; raw SDK and database errors withheld."); process.exitCode = 1; });
