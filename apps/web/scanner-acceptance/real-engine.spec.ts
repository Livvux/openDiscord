import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { createCommunity, newUserPage, signUp } from "../e2e/helpers";

const run = promisify(execFile);
const clean = Buffer.from("Harmless scanner acceptance attachment.\n");
// Standard harmless EICAR antivirus test file, assembled only in the disposable test.
const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function command(command: string, payload?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: 3310 });
    let response = "";
    socket.setTimeout(10_000, () => socket.destroy(new Error("clamd deadline")));
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(`z${command}\0`);
      if (payload) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(payload.length);
        socket.write(length);
        socket.write(payload);
        socket.write(Buffer.alloc(4));
      }
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString();
      if (response.length > 4096) socket.destroy(new Error("clamd response too large"));
      if (response.includes("\0")) { socket.destroy(); resolve(response.split("\0")[0]); }
    });
    socket.on("end", () => { if (!response.includes("\0")) reject(new Error("Incomplete clamd response")); });
  });
}

test("real signatures reject EICAR and unavailable scanning before upload/import persistence", async ({ browser }, info) => {
  const directory = process.env.ATTACHMENT_DIR;
  const databaseUrl = process.env.DATABASE_URL;
  const container = process.env.SCANNER_CONTAINER;
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.OPENDISCORD_SCANNER_ACCEPTANCE !== "1"
    || !directory?.startsWith("/tmp/opendiscord-scanner-") || !databaseUrl
    || new URL(databaseUrl).hostname !== "localhost" || !container?.startsWith("opendiscord-scanner-")) {
    throw new Error("Requires the owned disposable scanner CI fixture");
  }
  const db = new Pool({ connectionString: databaseUrl });
  const page = await newUserPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const pages = [page];
  const emails: string[] = [];
  async function inventory() {
    const files = await readdir(join(directory!, "attachments")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return {
      rows: (await db.query("SELECT id, key, size FROM attachment ORDER BY id")).rows as unknown[],
      communities: (await db.query("SELECT id FROM community ORDER BY id")).rows as unknown[],
      files: await Promise.all(files.sort().map(async (name) => ({ name, hash: hash(await readFile(join(directory!, "attachments", name))) }))),
    };
  }
  const results: { phase: string; upload: number; import: number; unchanged: boolean }[] = [];
  try {
    expect((await db.query('SELECT id FROM "user"')).rows).toHaveLength(0);
    expect((await inventory()).files).toHaveLength(0);
    const version = await command("VERSION");
    expect(version).toMatch(/^ClamAV .+\/\d+\/.+/);
    expect(await command("INSTREAM", clean)).toBe("stream: OK");
    expect(await command("INSTREAM", eicar)).toMatch(/^stream: .*Eicar.* FOUND$/i);
    await writeFile(info.outputPath("engine.json"), JSON.stringify({ version, image: process.env.SCANNER_IMAGE, capturedAt: new Date().toISOString() }, null, 2));
    emails.push(await signUp(page, "Scanner Acceptance"));
    await createCommunity(page, "Private scanner fixture");
    const match = new URL(page.url()).pathname.match(/\/app\/c\/([^/]+)\/([^/]+)/);
    if (!match) throw new Error("Missing community/channel route");
    const [, communityId, channelId] = match;
    const uploadUrl = `/api/channels/${channelId}/attachments`;
    const origin = "http://localhost:3200";
    const upload = (data: Buffer) => page.request.post(uploadUrl, {
      headers: { origin, "content-type": "application/octet-stream", "x-filename": "acceptance.txt" }, data,
    });
    const chooser = page.waitForEvent("filechooser");
    const cleanUpload = page.waitForResponse((response) => response.url().endsWith(uploadUrl) && response.request().method() === "POST");
    await page.getByRole("button", { name: /Attach files/ }).click();
    await (await chooser).setFiles({ name: "clean.txt", mimeType: "text/plain", buffer: clean });
    expect((await cleanUpload).status()).toBe(201);
    await expect(page.getByRole("list", { name: "Attachments" }).getByRole("status")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Message #general" }).fill("Scanner clean file");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("log").getByRole("link", { name: /clean.txt/ })).toBeVisible();
    const exported = await page.request.get(`/api/communities/${communityId}/export?attachments=1`);
    expect(exported.status()).toBe(200);
    const archive = await exported.body();
    const importArchive = (actor: Page, data: Buffer) => actor.request.post("/api/communities/import", {
      headers: { origin, "content-type": "application/gzip" }, data,
    });
    expect((await importArchive(page, archive)).status()).toBe(201);
    const accepted = await inventory();
    expect(accepted.rows).toHaveLength(2);
    expect(accepted.files.map((file) => file.hash)).toEqual([hash(clean), hash(clean)]);
    // Preserve the application's valid archive metadata; replace just this one file and its digest.
    const records: unknown[] = gunzipSync(archive).toString().trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
    const infected = records.map((record) => {
      if (!record || typeof record !== "object" || !("type" in record)) throw new Error("Invalid exported fixture");
      if (record.type === "file") return { ...record, size: eicar.length };
      if (record.type === "chunk") return { ...record, data: eicar.toString("base64") };
      if (record.type === "file-end") return { ...record, sha256: hash(eicar) };
      if (record.type === "end") return { ...record, bytes: eicar.length };
      return record;
    });
    const infectedArchive = gzipSync(infected.map((record) => JSON.stringify(record)).join("\n") + "\n");
    for (const phase of ["eicar", "unavailable"] as const) {
      // A real account gets one archive attempt per ten minutes. Each phase owns
      // a fresh authenticated actor instead of resetting or bypassing that limit.
      const importer = await newUserPage(browser);
      pages.push(importer);
      importer.on("pageerror", (error) => errors.push(error.message));
      emails.push(await signUp(importer, `Scanner ${phase}`));
      if (phase === "unavailable") await run("docker", ["stop", "--time", "5", container]);
      const before = await inventory();
      const uploaded = await upload(phase === "eicar" ? eicar : clean);
      const expectedStatus = phase === "eicar" ? 400 : 409;
      const message = phase === "eicar" ? "rejected by the malware scanner" : "scanner is unavailable";
      const uploadBody = await uploaded.text();
      expect(uploaded.status(), uploadBody).toBe(expectedStatus);
      expect(uploadBody).toContain(message);
      expect(await inventory()).toEqual(before);
      const imported = await importArchive(importer, phase === "eicar" ? infectedArchive : archive);
      const importBody = await imported.text();
      expect(imported.status(), importBody).toBe(expectedStatus);
      expect(importBody).toContain(message);
      expect(await inventory()).toEqual(before);
      results.push({ phase, upload: uploaded.status(), import: imported.status(), unchanged: true });
    }
    await page.screenshot({ path: info.outputPath("real-scanner-clean-upload.png"), fullPage: true });
    expect(errors).toEqual([]);
    await writeFile(info.outputPath("acceptance.json"), JSON.stringify({ cleanUploadAndImport: true, results, pageErrors: errors.length }, null, 2));
  } finally {
    if (emails.length) {
      await db.query('DELETE FROM attachment WHERE uploader_id IN (SELECT id FROM "user" WHERE email = ANY($1::text[]))', [emails]);
      await db.query('DELETE FROM community WHERE owner_id IN (SELECT id FROM "user" WHERE email = ANY($1::text[]))', [emails]);
      await db.query('DELETE FROM "user" WHERE email = ANY($1::text[])', [emails]);
    }
    await Promise.all(pages.map((owned) => owned.context().close()));
    await db.end();
  }
});
