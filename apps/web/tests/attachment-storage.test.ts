import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localAttachmentStorage } from "@/server/attachment-storage";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "opendiscord-media-"));
  directories.push(directory);
  return { directory, storage: localAttachmentStorage(directory), key: `attachments/${randomUUID()}.bin` };
}

describe("private local attachment storage", () => {
  it("stores complete private bytes, streams them and removes idempotently", async () => {
    const { directory, storage, key } = await fixture();
    await storage.put(key, new TextEncoder().encode("private file"), "application/octet-stream");
    expect((await stat(join(directory, key))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, key), "utf8")).toBe("private file");
    const response = await storage.read(key);
    expect(response.headers.get("Content-Length")).toBe("12");
    expect(await response.text()).toBe("private file");
    expect(await storage.remove(key)).toBe(true);
    expect(await storage.remove(key)).toBe(true);
    expect((await storage.read(key)).status).toBe(404);
  });
  it("rejects traversal, arbitrary file names, relative roots and leaf symlinks", async () => {
    const { directory, storage, key } = await fixture();
    expect(() => localAttachmentStorage("public/uploads")).toThrow();
    await expect(storage.put("attachments/../../secret", new Uint8Array(), "text/plain")).rejects.toThrow();
    await expect(storage.read("/etc/passwd")).rejects.toThrow();
    await storage.put(key, new TextEncoder().encode("file"), "application/octet-stream");
    await storage.remove(key);
    await symlink("/etc/passwd", join(directory, key));
    expect((await storage.read(key)).status).toBe(404);
  });
});
