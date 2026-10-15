import { createHmac } from "node:crypto";

/** Acts as an authenticator app: the provisioning URI contains a Base32 key (RFC 6238). */
export function authenticatorCode(base32Secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...base32Secret.toUpperCase().replace(/=+$/, "")].map((c) => {
    const value = alphabet.indexOf(c);
    if (value < 0) throw new Error("Invalid Base32 authenticator key");
    return value.toString(2).padStart(5, "0");
  }).join("");
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
