// Realtime fan-out over Postgres LISTEN/NOTIFY: every web process holds one LISTEN connection
// and forwards events to its own SSE subscribers, so several replicas work without Redis.
// Payloads carry ids only (NOTIFY is capped at 8 kB); subscribers re-read data they need.
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";

const CHANNEL = "opendiscord_events";

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.created"), communityId: z.string(), channelId: z.string(), messageId: z.string() }),
  z.object({ type: z.literal("message.updated"), communityId: z.string(), channelId: z.string(), messageId: z.string() }),
  z.object({ type: z.literal("message.deleted"), communityId: z.string(), channelId: z.string(), messageId: z.string() }),
  z.object({ type: z.literal("channels.changed"), communityId: z.string() }),
  z.object({ type: z.literal("member.removed"), communityId: z.string(), userId: z.string() }),
  z.object({ type: z.literal("community.deleted"), communityId: z.string() }),
]);

export type RealtimeEvent = z.infer<typeof eventSchema>;
/** Delivered to subscribers; `resync` means events may have been missed. */
export type HubEvent = RealtimeEvent | { type: "resync"; communityId: string };
type Listener = (event: HubEvent) => void;

export async function publish(event: RealtimeEvent): Promise<void> {
  await db.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(event)})`);
}

class Hub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private retryMs = 500;

  subscribe(communityId: string, listener: Listener): () => void {
    const set = this.listeners.get(communityId) ?? new Set();
    set.add(listener);
    this.listeners.set(communityId, set);
    void this.ensureConnected();
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(communityId);
    };
  }

  private dispatch(event: HubEvent) {
    for (const listener of this.listeners.get(event.communityId) ?? []) listener(event);
  }

  private ensureConnected(): Promise<void> {
    if (this.client) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connect() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.on("notification", (msg) => {
      let payload: unknown;
      try {
        payload = JSON.parse(msg.payload ?? "null");
      } catch {
        return;
      }
      const parsed = eventSchema.safeParse(payload);
      if (parsed.success) this.dispatch(parsed.data);
    });
    client.on("error", (error) => {
      console.error("[realtime] listen connection lost", error.message);
      this.client = null;
      void client.end().catch(() => {});
      // Anything published while disconnected is lost: tell clients to refetch.
      for (const communityId of this.listeners.keys()) this.dispatch({ type: "resync", communityId });
      setTimeout(() => void this.ensureConnected(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.retryMs = 500;
    } catch (error) {
      console.error("[realtime] could not connect", error);
      await client.end().catch(() => {});
      setTimeout(() => void this.ensureConnected(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    }
  }
}

// One hub per process, also across dev-server hot reloads.
const globalHub = globalThis as unknown as { __opendiscordHub?: Hub };
export const hub = (globalHub.__opendiscordHub ??= new Hub());
