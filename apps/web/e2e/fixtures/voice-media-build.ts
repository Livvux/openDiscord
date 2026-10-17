import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { assertDisposableVoiceCi } from "./voice-media-observer";

/** Preserve every nested output path; never follow links or serve a directory. */
export async function readVoiceMediaAssets(directory: string): Promise<Map<string, Buffer>> {
  const assets = new Map<string, Buffer>();
  async function visit(prefix: string): Promise<void> {
    const entries = await readdir(join(directory, prefix), { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[A-Za-z0-9_.-]+$/.test(entry.name) || entry.name === "." || entry.name === ".." || entry.isSymbolicLink()) throw new Error("Unexpected static asset path.");
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) assets.set(name, await readFile(join(directory, name)));
      else throw new Error("Unexpected static asset type.");
    }
  }
  await visit("");
  return assets;
}

/** Isolated CI-only static bundle. No app/proof route or HTTP transport replacement. */
export async function buildVoiceMediaHarness() {
  assertDisposableVoiceCi({ ci: process.env.CI, githubActions: process.env.GITHUB_ACTIONS, apiKey: process.env.LIVEKIT_API_KEY, apiSecret: process.env.LIVEKIT_API_SECRET, url: process.env.LIVEKIT_URL, authUrl: process.env.BETTER_AUTH_URL });
  // Playwright loads these Node-only TS helpers as CJS in this package.
  const require = createRequire(join(process.cwd(), "package.json"));
  // Vite is already locked and installed as Vitest's peer. No dependency/lockfile change.
  const vitePath = require.resolve("vite", { paths: [dirname(require.resolve("vitest/package.json"))] });
  const vite: { build(config: Record<string, unknown>): Promise<unknown> } = await import(pathToFileURL(vitePath).href);
  const directory = await mkdtemp(join(tmpdir(), "opendiscord-media-ci-"));
  await vite.build({
    configFile: false, root: resolve("."), base: "/__voice-media-ci/", logLevel: "warn",
    resolve: { alias: { "@": resolve("src") } },
    build: { target: "esnext", outDir: directory, emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false,
      rolldownOptions: { input: resolve("e2e/fixtures/voice-media-session.ts"), preserveEntrySignatures: "strict", output: { entryFileNames: "entry.js", chunkFileNames: "chunk-[name].js", assetFileNames: "[name][extname]" } } },
  });
  const assets = await readVoiceMediaAssets(directory);
  const names = [...assets.keys()];
  if (!names.includes("entry.js") || !names.some(name => name.endsWith(".wasm")) || !names.some(name => name.includes("e2ee") && name.endsWith(".mjs"))) throw new Error("Actual worker/WASM bundle assets missing.");
  return {
    async serve(page: Page) {
      const origin = new URL(page.url()).origin;
      // Register only the finite emitted static asset URLs. All HTML/API requests stay real.
      for (const [name, body] of assets) await page.route(`${origin}/__voice-media-ci/${name}`, route => route.fulfill({ status: 200, contentType: name.endsWith(".wasm") ? "application/wasm" : "text/javascript", body }));
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
