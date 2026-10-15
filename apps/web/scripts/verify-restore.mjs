// CI-only encrypted restore rehearsal. Never invoke the destructive production restore helper.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

const container = process.argv[2];
if (process.env.CI !== "true" || !container || !/^[a-f0-9]{12,64}$/.test(container)) {
  throw new Error("Requires CI=true and the GitHub Actions PostgreSQL service container ID");
}
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== "localhost" || url.pathname !== "/opendiscord") {
  throw new Error("Requires the isolated localhost CI database");
}
const id = randomUUID().replaceAll("-", "");
const source = `restore_source_${id}`;
const target = `restore_target_${id}`;
const directory = mkdtempSync(join(tmpdir(), "opendiscord-restore-"));
const admin = new Client({ connectionString: url.toString() });
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const docker = (args, input) => execFileSync("docker", ["exec", "-i", container, ...args], {
  input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
const dump = (database) => docker(["pg_dump", "-U", "opendiscord", "-d", database, "--format=custom", "--no-owner"]);
const restore = (database, input) => docker(["pg_restore", "-U", "opendiscord", "-d", database, "--no-owner", "--exit-on-error"], input);

async function snapshot(database) {
  const connection = new URL(url);
  connection.pathname = `/${database}`;
  const client = new Client({ connectionString: connection.toString() });
  await client.connect();
  try {
    const { rows: tables } = await client.query(`SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename`);
    const result = [];
    for (const { schemaname, tablename } of tables) {
      const { rows } = await client.query(`SELECT count(*)::text AS count,
        md5(coalesce(string_agg(value::text, E'\\n' ORDER BY value::text), '')) AS digest
        FROM (SELECT to_jsonb(t) AS value FROM ${quote(schemaname)}.${quote(tablename)} t) data`);
      result.push({ schemaname, tablename, ...rows[0] });
    }
    return JSON.stringify(result);
  } finally {
    await client.end();
  }
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quote(source)}`);
  await admin.query(`CREATE DATABASE ${quote(target)}`);
  restore(source, dump("opendiscord"));
  docker(["psql", "-U", "opendiscord", "-d", source, "-v", "ON_ERROR_STOP=1", "-c",
    "CREATE TABLE public.operations_restore_probe (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO public.operations_restore_probe VALUES (1, 'encrypted restore sentinel');"]);

  const key = join(directory, "identity");
  execFileSync("age-keygen", ["-o", key], { stdio: "pipe" });
  const recipient = execFileSync("age-keygen", ["-y", key], { encoding: "utf8" }).trim();
  const encrypted = execFileSync("age", ["-r", recipient], { input: dump(source), maxBuffer: 64 * 1024 * 1024 });
  const archive = join(directory, "backup.dump.age");
  writeFileSync(archive, encrypted, { mode: 0o600 });
  const decrypted = execFileSync("age", ["-d", "-i", key], { input: readFileSync(archive), maxBuffer: 64 * 1024 * 1024 });
  restore(target, decrypted);
  if (await snapshot(source) !== await snapshot(target)) throw new Error("Restored data differs");
  // Authentication must reject a damaged encrypted archive before PostgreSQL sees it.
  const damaged = Buffer.from(encrypted);
  damaged[damaged.length - 1] ^= 1;
  let rejected = false;
  try {
    execFileSync("age", ["-d", "-i", key], { input: damaged, stdio: ["pipe", "pipe", "pipe"] });
  } catch { rejected = true; }
  if (!rejected) throw new Error("Damaged archive was accepted");
  console.log("Encrypted backup restored in isolation; all table row counts/digests match; corrupted archive rejected.");
} finally {
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(source)} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${quote(target)} WITH (FORCE)`);
  } finally {
    await admin.end();
    rmSync(directory, { recursive: true, force: true });
  }
}
