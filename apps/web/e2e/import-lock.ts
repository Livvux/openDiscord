import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "@playwright/test";

/** Imports intentionally share a process-wide server admission slot, including across projects. */
export function withCommunityImport<T>(operation: () => Promise<T>): Promise<T> {
  return withImportLock(join(test.info().project.outputDir, ".community-import.lock"), operation);
}

export async function withImportLock<T>(directory: string, operation: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(directory);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw new Error("Timed out waiting for the E2E community import fixture lock.");
      await setTimeout(25);
    }
  }
  try {
    return await operation();
  } finally {
    // Only the successful mkdir owner releases; abandoned locks fail bounded instead of being stolen.
    await rmdir(directory);
  }
}
