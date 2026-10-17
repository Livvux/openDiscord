import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withImportLock } from "./import-lock";

test("an occupied import slot fails bounded without running or releasing another owner's operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendiscord-import-lock-"));
  const lock = join(root, "slot");
  let competingCalls = 0;
  try {
    await withImportLock(lock, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(withImportLock(lock, async () => { competingCalls++; }, 50)).rejects.toThrow("Timed out waiting");
      }
    });
    expect(competingCalls).toBe(0);
    await expect(withImportLock(lock, async () => "admitted")).resolves.toBe("admitted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed import releases admission and preserves the operation failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendiscord-import-lock-"));
  const lock = join(root, "slot");
  try {
    await expect(withImportLock(lock, async () => { throw new Error("Synthetic import rejected"); })).rejects.toThrow("Synthetic import rejected");
    await expect(withImportLock(lock, async () => "next import")).resolves.toBe("next import");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
