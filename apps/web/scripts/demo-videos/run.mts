// Usage: pnpm tsx scripts/demo-videos/run.mts [chat|threads|moderation|invite ...]
import { startProxy } from "./proxy.mjs";
import { launch } from "./lib.mjs";
import * as takes from "./takes.mjs";

const all = ["chat", "threads", "moderation", "invite"] as const;
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : [...all];
const stopProxy = await startProxy();
const browser = await launch();
try {
  for (const name of wanted) {
    const take = (takes as Record<string, (b: typeof browser) => Promise<string>>)[name];
    if (!take) throw new Error(`unknown take: ${name}`);
    console.log(name, "->", await take(browser));
  }
} finally {
  await browser.close();
  await stopProxy();
}
