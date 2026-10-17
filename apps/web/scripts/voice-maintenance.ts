import { db } from "../src/db";
import { sweepVoiceLifecycle } from "../src/server/voice-control";

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--apply") || args.length > 1) throw new Error("Invalid arguments");
    const apply = args.includes("--apply");
    const { scanned, closed, removed, limited, rooms } = await sweepVoiceLifecycle({ apply, now: new Date(), batchSize: 8, maxBatches: 1 });
    // Explicit allowlist: never serialize call IDs or native/SFU identifiers.
    console.log(JSON.stringify({ apply, scanned, closed, removed, limited, rooms: {
      claimed: rooms.claimed, requests: rooms.requests, retired: rooms.retired, deleted: rooms.deleted,
      failed: rooms.failed, unavailable: rooms.unavailable, limited: rooms.limited,
    } }));
    if (rooms.failed || rooms.unavailable) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

void main().catch(() => {
  console.error("Voice maintenance failed; no credentials or row contents have been logged. Check private operator status and database availability.");
  process.exitCode = 1;
});
