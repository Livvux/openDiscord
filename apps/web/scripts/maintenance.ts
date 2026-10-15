import { db } from "../src/db";
import { runMaintenance } from "../src/server/maintenance";

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: maintenance.ts [--apply] (dry run by default)");
    console.log(JSON.stringify(await runMaintenance({ apply: args.includes("--apply") })));
  } finally {
    await db.$client.end();
  }
}

void main().catch(() => {
  console.error("Maintenance failed; no credentials or row contents have been logged. Check database availability and migrations.");
  process.exitCode = 1;
});
