import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";

/** Isolated CI-only static bundle. No app/proof route or HTTP transport replacement. */
export async function buildVoiceMediaHarness() {
  const require = createRequire(import.meta.url);
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
  const names = await readdir(directory);
  if (!names.includes("entry.js") || !names.some(name => name.endsWith(".wasm")) || !names.some(name => name.includes("e2ee") && name.endsWith(".mjs"))) throw new Error("Actual worker/WASM bundle assets missing.");
  const assets = new Map(await Promise.all(names.map(async name => {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Unexpected static asset path.");
    return [name, await readFile(join(directory, name))] as const;
  })));
  return {
    async serve(page: Page) {
      const origin = new URL(page.url()).origin;
      // Register only the finite emitted static asset URLs. All HTML/API requests stay real.
      for (const [name, body] of assets) await page.route(`${origin}/__voice-media-ci/${name}`, route => route.fulfill({ status: 200, contentType: name.endsWith(".wasm") ? "application/wasm" : "text/javascript", body }));
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
