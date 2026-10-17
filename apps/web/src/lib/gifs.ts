/** Only provider-operated media CDNs may be rendered as GIFs. Arbitrary links remain plain links. */
export type GifSource = "giphy" | "klipy";

export function gifSource(value: string): GifSource | null {
  if (value.length > 2048 || value !== value.trim() || /\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
  if (!/\.(gif|webp)$/i.test(url.pathname)) return null;
  if (/^(media\d*|i)\.giphy\.com$/.test(url.hostname)) return "giphy";
  if (/^static[12]?\.klipy\.com$/.test(url.hostname)) return "klipy";
  return null;
}
