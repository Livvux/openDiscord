import { createServer, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { scanAttachment } from "@/server/attachment-scanner";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });
async function scanner(reply: string | null) {
  const clients = new Set<Socket>();
  let received = Buffer.alloc(0);
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 14) {
        const length = received.readUInt32BE(10);
        if (received.length >= 18 + length && reply !== null) socket.end(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    clients.forEach((socket) => socket.destroy());
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing scanner port");
  return { port: address.port, received: () => received };
}

it("sends the clamd INSTREAM framing and accepts only a clean verdict", async () => {
  const probe = await scanner("stream: OK\0");
  await scanAttachment(new TextEncoder().encode("payload"), "127.0.0.1", probe.port);
  expect(probe.received().subarray(0, 10).toString()).toBe("zINSTREAM\0");
  expect(probe.received().readUInt32BE(10)).toBe(7);
  expect(probe.received().subarray(14, 21).toString()).toBe("payload");
  expect(probe.received().readUInt32BE(21)).toBe(0);
});

it.each(["stream: Eicar-Test-Signature FOUND\0", "INSTREAM size limit exceeded. ERROR\0", "not a verdict\0"])("rejects scanner verdict %s", async (reply) => {
  const probe = await scanner(reply);
  await expect(scanAttachment(new Uint8Array([1]), "127.0.0.1", probe.port)).rejects.toThrow();
});

it("fails closed on a stalled scanner and accepts explicitly disabled scanning", async () => {
  const probe = await scanner(null);
  await expect(scanAttachment(new Uint8Array([1]), "127.0.0.1", probe.port, 25)).rejects.toThrow("unavailable");
  await expect(scanAttachment(new Uint8Array([1]), "")).resolves.toBeUndefined();
});

async function closedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

it("fails closed when the configured scanner refuses the connection", async () => {
  await expect(scanAttachment(new Uint8Array([1]), "127.0.0.1", await closedPort())).rejects.toThrow("unavailable");
});

it("fails closed when the scanner hangs up without a verdict", async () => {
  const probe = await scanner("");
  await expect(scanAttachment(new Uint8Array([1]), "127.0.0.1", probe.port)).rejects.toThrow("unavailable");
});

it("fails closed on an oversized or unterminated reply", async () => {
  const flood = await scanner("x".repeat(5000));
  await expect(scanAttachment(new Uint8Array([1]), "127.0.0.1", flood.port)).rejects.toThrow("unavailable");
  const unterminated = await scanner("stream: OK");
  await expect(scanAttachment(new Uint8Array([1]), "127.0.0.1", unterminated.port)).rejects.toThrow("unavailable");
});

it("names a detection as a malware rejection, not an outage", async () => {
  const probe = await scanner("stream: Eicar-Test-Signature FOUND\0");
  await expect(scanAttachment(new Uint8Array([1]), "127.0.0.1", probe.port)).rejects.toThrow("malware scanner");
});

it("refuses an invalid scanner port instead of skipping the scan", async () => {
  await expect(scanAttachment(new Uint8Array([1]), "127.0.0.1", 70000)).rejects.toThrow("CLAMAV_PORT");
  await expect(scanAttachment(new Uint8Array([1]), "127.0.0.1", Number.NaN)).rejects.toThrow("CLAMAV_PORT");
});
