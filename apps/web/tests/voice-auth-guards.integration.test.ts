import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
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

async function blockedBy(pid: number, blocker: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows } = await db.$client.query<{ blocked: boolean }>("select $2 = any(pg_blocking_pids($1)) as blocked", [pid, blocker]);
    if (rows[0].blocked) return;
  }
  throw new Error(`Backend ${pid} did not reach blocker ${blocker}`);
}
function sqlState(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

describe("real PostgreSQL rejected and ordered native guard lock graphs", () => {
  for (const ordered of [false, true]) {
    it(`${ordered ? "resolves" : "reproduces"} DM upload versus native user cascade deadlock`, async () => {
      const schema = `voice_guard_probe_${randomUUID().replaceAll("-", "")}`;
      const dm = await db.$client.connect(), native = await db.$client.connect();
      let cascade: Promise<unknown> | undefined, upload: Promise<unknown> | undefined;
      try {
        await db.$client.query(`create schema "${schema}";
          create table "${schema}".actor (id int primary key);
          create table "${schema}".device (id int primary key, actor int references "${schema}".actor on delete cascade, value int default 0);
          insert into "${schema}".actor values (1); insert into "${schema}".device(id,actor) values(1,1);
          create function "${schema}".guard() returns trigger language plpgsql as $$ begin
            ${ordered ? "perform pg_advisory_xact_lock(810025);" : ""}
            perform pg_advisory_xact_lock(810030); return null; end; $$;
          create trigger guard before delete on "${schema}".actor for each statement execute function "${schema}".guard();
          create trigger guard before update on "${schema}".device for each statement execute function "${schema}".guard();`);
        for (const c of [dm, native]) {
          await c.query("begin");
          await c.query("set local lock_timeout = '5s'");
          await c.query("set local statement_timeout = '6s'");
        }
        const { rows: [{ pid: dmPid }] } = await dm.query<{ pid: number }>("select pg_backend_pid() as pid");
        const { rows: [{ pid: nativePid }] } = await native.query<{ pid: number }>("select pg_backend_pid() as pid");
        await dm.query("select pg_advisory_xact_lock(810025)");
        await dm.query(`select * from "${schema}".device where id = 1 for share`);
        cascade = native.query(`delete from "${schema}".actor where id = 1`).then(async () => { await native.query("commit"); return null; }, async (error: unknown) => { await native.query("rollback"); return error; });
        if (ordered) await waitingFor(nativePid, 810025);
        else await blockedBy(nativePid, dmPid);
        upload = dm.query(`update "${schema}".device set value = 1 where id = 1`).then(async () => { await dm.query("commit"); return null; }, async (error: unknown) => { await dm.query("rollback"); return error; });
        const results = await Promise.all([cascade, upload]);
        if (ordered) expect(results).toEqual([null, null]);
        else expect(results.map(sqlState).filter(Boolean)).toEqual(["40P01"]);
        const { rows } = await db.$client.query<{ count: number }>(`select count(*)::int as count from "${schema}".actor`);
        expect(rows[0].count).toBe(ordered ? 0 : results[0] === null ? 0 : 1);
      } finally {
        await Promise.all([cascade, upload]);
        await dm.query("rollback"); await native.query("rollback");
        dm.release(); native.release();
        await db.$client.query(`drop schema if exists "${schema}" cascade`);
      }
    }, 12000);
  }
});

describe("bounded ordered-guard contention characterization", () => {
  it("records auth/DM/Voice DB critical sections and pool wait without a performance SLO", async () => {
    const id = await users.create("Guard contention fixture");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, statement_timeout: 6000, lock_timeout: 5000 });
    const started = performance.now();
    const waits: number[] = [];
    let peakWaiting = 0;
    try {
      const operations = Array.from({ length: 18 }, async (_, index) => {
        const requested = performance.now(), connection = pool.connect();
        peakWaiting = Math.max(peakWaiting, pool.waitingCount);
        const c = await connection;
        waits.push(performance.now() - requested);
        try {
          await c.query("begin");
          if (index % 3 === 0) await c.query('update public."user" set name = name where id = $1', [id]);
          else if (index % 3 === 1) {
            await c.query("select pg_advisory_xact_lock(810025)");
            await c.query("select id from public.dm_device where user_id = $1 for share", [id]);
            await c.query("update public.dm_device set name = name where false");
          } else {
            await c.query("select pg_advisory_xact_lock(810030)");
            await c.query("select id from public.voice_call where false");
          }
          await c.query("commit");
          return null;
        } catch (error) { await c.query("rollback"); return sqlState(error) ?? "unknown"; }
        finally { c.release(); }
      });
      expect(await Promise.all(operations)).toEqual(Array(18).fill(null));
      expect(peakWaiting).toBeGreaterThan(0);
      console.info("[voice guard characterization]", JSON.stringify({ operations: 18, pool: 3, peakWaiting, elapsedMs: Math.round(performance.now() - started), maxPoolWaitMs: Math.round(Math.max(...waits)), scope: "isolated DB-only no-call workload; not a capacity or production latency claim" }));
    } finally { await pool.end(); }
  }, 12000);
});

describe("operator bootstrap entry ordering", () => {
  it("takes DM then Voice before the administrator advisory and preserves zero-admin bootstrap", async () => {
    const id = await users.create("Lifecycle bootstrap fixture"), barrier = await db.$client.connect();
    let completed: Promise<{ code: number | null; stderr: string }> | undefined;
    try {
      await barrier.query("begin"); await barrier.query("set local lock_timeout = '2s'");
      await barrier.query("select pg_advisory_xact_lock(810030)");
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/bootstrap-instance-admin.ts", `${id}@example.test`, "Lifecycle ordered bootstrap test"], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      completed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve({ code, stderr })); });
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (Date.now() < deadline) {
        const { rows } = await db.$client.query<{ waiting: boolean }>("select exists(select 1 from pg_locks where locktype = 'advisory' and classid = 0 and objid = 810030 and not granted) as waiting");
        if (rows[0].waiting) { waiting = true; break; }
      }
      expect(waiting).toBe(true);
      // Bootstrap must not already own the conflicting administrator lock while waiting for Voice.
      await barrier.query("select pg_advisory_xact_lock(187412, 1)");
      await barrier.query("commit");
      const result = await completed;
      expect(result.stderr).toBe(""); expect(result.code).toBe(0);
      const { rows } = await db.$client.query("select user_id from public.instance_admin where user_id = $1", [id]);
      expect(rows).toHaveLength(1);
    } finally {
      await barrier.query("rollback"); await completed?.catch(() => {}); barrier.release();
      await db.$client.query("delete from public.instance_admin where user_id = $1", [id]);
    }
  }, 12000);
});
