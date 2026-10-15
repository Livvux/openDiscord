import { randomBytes } from "node:crypto";

let lastMs = -1;
let counter = 0;

/**
 * RFC 9562 UUIDv7 for a given time, monotonic within a millisecond (12-bit counter in rand_a).
 * Used where the original time matters, e.g. imported messages keep their chronological order.
 */
export function uuidv7(ms: number): string {
  counter = ms === lastMs ? (counter + 1) & 0xfff : 0;
  lastMs = ms;
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
