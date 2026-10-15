export function getMinimumAge(): number {
  const raw = process.env.MINIMUM_AGE ?? "16";
  const age = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(age) || age < 13 || age > 99) throw new Error("MINIMUM_AGE must be an integer from 13 to 99");
  return age;
}

export interface OperatorDetails { name: string; address: string; country: string; email: string }

export function isOfficialInstance(): boolean {
  return new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").hostname === "opendiscord.app";
}

/** Official-instance defaults never identify a different self-hoster as lk media. */
export function getOperatorDetails(): OperatorDetails | null {
  const official = isOfficialInstance();
  const name = process.env.OPERATOR_NAME || (official ? "lk media" : "");
  const address = process.env.OPERATOR_ADDRESS || (official ? "Felchenstr 21\n76437 Rastatt" : "");
  const country = process.env.OPERATOR_COUNTRY || (official ? "Germany" : "");
  const email = process.env.OPERATOR_EMAIL || (official ? "info@opendiscord.app" : "");
  return name && address && country && email ? { name, address, country, email } : null;
}
