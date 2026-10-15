/**
 * Shortens a file name in the middle so its extension always stays visible
 * ("invoice-….exe", never "invoice-………"), which defeats long-name extension spoofing.
 */
export function shortFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  const head = Math.max(1, max - ext.length - 1);
  return `${name.slice(0, head)}…${ext}`;
}
