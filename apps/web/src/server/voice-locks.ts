import { sql } from "drizzle-orm";
import type { Db } from "./access";

/** Enter before any row/admin lock. Voice-only callers must never upgrade or write auth tables. */
export async function lockVoiceLifecycle(tx: Pick<Db, "execute">, mode: "voice" | "auth" = "voice") {
  if (mode === "auth") await tx.execute(sql`select pg_advisory_xact_lock(810025)`);
  await tx.execute(sql`select pg_advisory_xact_lock(810030)`);
}
