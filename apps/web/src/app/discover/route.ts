import { listDiscoverable } from "@/server/discovery";
import { listPublicChannels } from "@/server/public-channels";
import { escapeHtml, publicHtml } from "@/server/public-html";
import { requireUser } from "@/server/session";

const plural = (n: number, word: string) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

export async function GET(request: Request) {
  // Signed in: Discover lives inside the app, next to the server rail, as in Discord.
  if (await requireUser(request.headers).catch(() => null)) return new Response(null, { status: 307, headers: { Location: "/app/discover", "Cache-Control": "private, no-store" } });
  const before = new URL(request.url).searchParams.get("before");
  const [communities, { channels, next }] = await Promise.all([before ? [] : listDiscoverable(), listPublicChannels(before)]);
  const cards = communities.map((c) => `<li class="card"><a href="/sign-in?next=${encodeURIComponent(`/app/discover/${c.id}`)}"><h2>${escapeHtml(c.name)}</h2>${c.description ? `<p>${escapeHtml(c.description)}</p>` : ""}<p class="muted">${c.onlineCount.toLocaleString("en")} online · ${plural(c.memberCount, "member")}</p></a></li>`).join("");
  const communitySection = before ? "" : `<h1>Find your community on openDiscord</h1>${cards ? `<ul class="cards" aria-label="Public communities">${cards}</ul>` : "<p>No public communities yet.</p>"}<p><a href="/sign-up">Create an account</a> to join one or start your own.</p>`;
  const channelSection = `<h2 class="section">Public channels</h2><p class="muted">Readable without an account. Reading does not join a community.</p><ul>${channels.map((ch) => `<li><p class="muted">${escapeHtml(ch.communityTitle)}</p><h2><a href="/public/${ch.id}">#${escapeHtml(ch.title)}</a></h2></li>`).join("")}</ul>${channels.length ? "" : before ? "<p>No more public channels.</p>" : "<p>No public channels yet.</p>"}${next ? `<a class="pagination" href="/discover?before=${next}">More public channels</a>` : ""}`;
  return publicHtml("Discover communities", communitySection + channelSection, "/discover");
}
