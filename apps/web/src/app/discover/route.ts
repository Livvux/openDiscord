import { listPublicChannels } from "@/server/public-channels";
import { escapeHtml, publicHtml } from "@/server/public-html";

export async function GET(request: Request) {
  const before = new URL(request.url).searchParams.get("before");
  const { channels, next } = await listPublicChannels(before);
  return publicHtml("Discover public channels", `<h1>Discover public channels</h1><p>Browse channels their owners explicitly made public. Reading does not join a community. Private channels and member lists stay private.</p><ul>${channels.map((ch) => `<li><p class="muted">${escapeHtml(ch.communityTitle)}</p><h2><a href="/public/${ch.id}">#${escapeHtml(ch.title)}</a></h2></li>`).join("")}</ul>${channels.length ? "" : before ? "<p>No more public channels.</p>" : `<p>No public channels yet. Community owners can list one here by creating a public channel.</p><p><a href="/sign-up">Create an account</a> to start a community, or open an invite link you received.</p>`}${next ? `<a class="pagination" href="/discover?before=${next}">More public channels</a>` : ""}`, "/discover");
}
