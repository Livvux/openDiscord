import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { testUsers } from "./helpers";

const users = testUsers();
afterAll(() => users.cleanup());
const guardedTables = ["user", "session", "account", "verification", "two_factor", "passkey", "dm_device"] as const;

// Poll actual PostgreSQL lock state, never elapsed time, as the overlap barrier.
async function waitingFor(pid: number, lock: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows } = await db.$client.query<{ waiting: boolean }>(`select exists (
      select 1 from pg_locks where pid = $1 and locktype = 'advisory'
      and classid = 0 and objid = $2 and objsubid = 1 and not granted
    ) as waiting`, [pid, lock]);
    if (rows[0].waiting) return;
  }
  throw new Error(`Backend ${pid} never waited for advisory ${lock}`);
}

describe("unreleased unconditional ordered native auth guards", () => {
  for (const table of guardedTables) {
    it(`serializes no-row ${table} writes behind DM before taking Voice`, async () => {
      const blocker = await db.$client.connect(), writer = await db.$client.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("begin");
        await blocker.query("select pg_advisory_xact_lock(810025)");
        await writer.query("begin");
        await writer.query("set local lock_timeout = '5s'");
        await writer.query("set local statement_timeout = '6s'");
        const { rows: [{ pid }] } = await writer.query<{ pid: number }>("select pg_backend_pid() as pid");
        pending = writer.query(`delete from public."${table}" where false`);
        // Attach rejection immediately; errors are asserted after releasing the barrier.
        const outcome = pending.then(() => null, (error: unknown) => error);
        await waitingFor(pid, 810025);
        const { rows } = await db.$client.query<{ count: number }>("select count(*)::int as count from pg_locks where pid = $1 and locktype = 'advisory' and classid = 0 and objid = 810030 and granted", [pid]);
        expect(rows[0].count).toBe(0);
        await blocker.query("commit");
        expect(await outcome).toBeNull();
        const { rows: held } = await writer.query<{ objid: number }>("select objid::int from pg_locks where pid = pg_backend_pid() and locktype = 'advisory' and granted order by objid");
        expect(held.map(row => row.objid)).toEqual([810025, 810030]);
        await writer.query("commit");
      } finally {
        await blocker.query("rollback");
        await pending?.catch(() => {});
        await writer.query("rollback");
        blocker.release(); writer.release();
      }
    });
  }
  it("retains both locks until transaction completion even without active calls", async () => {
    const id = await users.create("Guard transaction lifetime"), writer = await db.$client.connect();
    try {
      await writer.query("begin");
      await writer.query('update public."user" set name = name where id = $1', [id]);
      const { rows } = await writer.query<{ objid: number }>("select objid::int from pg_locks where pid = pg_backend_pid() and locktype = 'advisory' and granted order by objid");
      expect(rows.map(row => row.objid)).toEqual([810025, 810030]);
      await writer.query("rollback");
      const { rows: released } = await writer.query("select 1 from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'");
      expect(released).toHaveLength(0);
    } finally { await writer.query("rollback"); writer.release(); }
  });
  it("does not semantically revoke native profile writes", async () => {
    const id = await users.create("Ordinary profile update");
    await db.$client.query('update public."user" set name = $1 where id = $2', [`Profile ${randomUUID()}`, id]);
  });
});
