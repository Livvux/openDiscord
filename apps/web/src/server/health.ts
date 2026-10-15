import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { Client } from "pg";
import * as schema from "@/db/schema";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Resolve every required column without reading personal data. This also detects an
// application deployed ahead of its migrations, unlike SELECT 1 or table-only checks.
const schemaProbe = Object.values(schema)
  .filter((value) => is(value, PgTable))
  .map((table) => {
    const { name, schema: namespace, columns } = getTableConfig(table);
    return `SELECT ${columns.map((column) => quote(column.name)).join(", ")} FROM ${quote(namespace ?? "public")}.${quote(name)} LIMIT 0`;
  }).join("; ");

export async function checkReadiness(connectionString = process.env.DATABASE_URL): Promise<boolean> {
  if (!connectionString) return false;
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 1_000,
    statement_timeout: 1_000,
    query_timeout: 1_500,
  });
  // Connection loss between connect/query must not become an unhandled event.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query(schemaProbe);
    return true;
  } catch {
    return false;
  } finally {
    // Ending a busy client destroys its socket, including after a read timeout.
    await client.end().catch(() => {});
  }
}

let pending: Promise<boolean> | undefined;

export function readiness(): Promise<boolean> {
  // Share overlapping probes to bound connections; never cache a completed result.
  pending ??= checkReadiness().finally(() => { pending = undefined; });
  return pending;
}
