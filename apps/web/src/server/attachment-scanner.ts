import { createConnection } from "node:net";
import { AppError, invalid } from "./errors";

/** clamd INSTREAM protocol; configured scanning fails closed before any object is stored. */
export async function scanAttachment(data: Uint8Array, host = process.env.CLAMAV_HOST, port = Number(process.env.CLAMAV_PORT ?? 3310), timeoutMs = 20_000): Promise<void> {
  if (!host) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CLAMAV_PORT");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    let reply = Buffer.alloc(0);
    let settled = false;
    const unavailable = () => new AppError("conflict", "The upload scanner is unavailable. Please try again later.");
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const deadline = setTimeout(() => finish(unavailable()), timeoutMs);
    socket.on("error", () => finish(unavailable()));
    socket.on("end", () => finish(unavailable()));
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.byteLength);
      socket.write(length);
      socket.write(data);
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (chunk: Buffer) => {
      if (reply.byteLength + chunk.byteLength > 4096) { finish(unavailable()); return; }
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf(0);
      if (end === -1) return;
      const result = reply.subarray(0, end).toString("utf8");
      if (result === "stream: OK") finish();
      else if (/^stream: .+ FOUND$/.test(result)) finish(invalid("The upload was rejected by the malware scanner."));
      else finish(unavailable());
    });
  });
}
