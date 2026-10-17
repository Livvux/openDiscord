import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVoiceMediaAssets } from "../e2e/fixtures/voice-media-build";

const directories: string[] = [];
async function temporary() { const directory = await mkdtemp(join(tmpdir(), "voice-static-enumeration-")); directories.push(directory); return directory; }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("CI media static output enumeration (filesystem only, no bundler/media claim)", () => {
  it("reads actual nested files without dropping worker/WASM/chunks or treating directories as files", async () => {
    const directory = await temporary();
    await mkdir(join(directory, "assets", "native"), { recursive: true });
    await mkdir(join(directory, "brand"));
    const expected = new Map([
      ["entry.js", "entry"], ["assets/chunk-owner.js", "owner"],
      ["assets/native/livekit-client.e2ee.worker.mjs", "worker"],
      ["assets/native/matrix_sdk_crypto_wasm_bg.wasm", "wasm"], ["brand/icon.svg", "icon"],
    ]);
    for (const [name, content] of expected) await writeFile(join(directory, name), content);
    const actual = await readVoiceMediaAssets(directory);
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [name, content] of expected) expect(actual.get(name)?.toString()).toBe(content);
    expect(actual.has("assets")).toBe(false); expect(actual.has("assets/native")).toBe(false);
  });
  it.each(["file", "dir"] as const)("refuses a %s symlink instead of reading outside the isolated output", async type => {
    const directory = await temporary(), outside = await temporary();
    const target = type === "dir" ? outside : join(outside, "external.js");
    if (type === "file") await writeFile(target, "must never be served");
    await symlink(target, join(directory, "external"), type);
    await expect(readVoiceMediaAssets(directory)).rejects.toThrow("Unexpected static asset path");
  });
  it("refuses URL-unsafe path segments rather than installing a broad or ambiguous route", async () => {
    const directory = await temporary(); await mkdir(join(directory, "unsafe name"));
    await expect(readVoiceMediaAssets(directory)).rejects.toThrow("Unexpected static asset path");
  });
});
