/** Validate before Better Auth parses environment values: its format errors may echo a secret. */
export function authSecrets(raw: string | undefined): { version: number; value: string }[] | undefined {
  if (!raw) return undefined;
  const entries = raw.split(",");
  const invalid = () => new Error("Invalid BETTER_AUTH_SECRETS configuration; use unique version:secret entries with secrets of at least 32 characters.");
  if (entries.length > 8) throw invalid();
  const seen = new Set<number>();
  return entries.map((entry) => {
    const separator = entry.indexOf(":");
    const versionText = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    const version = Number(versionText);
    if (separator < 1 || !/^(0|[1-9][0-9]*)$/.test(versionText) || !Number.isSafeInteger(version)
      || value.length < 32 || value.length > 256 || /\s/.test(value) || seen.has(version)) throw invalid();
    seen.add(version);
    return { version, value };
  });
}
