import { readPublicChannel } from "@/server/public-channels";
import { escapeHtml, publicHtml, publicNotFound } from "@/server/public-html";

export async function GET(request: Request, ctx: RouteContext<"/public/[channelId]">) {
  const { channelId } = await ctx.params;
  const data = await readPublicChannel(channelId, new URL(request.url).searchParams.get("before"));
  if (!data) return publicNotFound();
  return publicHtml(`${data.title} — ${data.communityTitle}`, `<p class="muted">${escapeHtml(data.communityTitle)}</p><h1>#${escapeHtml(data.title)}</h1><p class="notice">Public text channel. Posts are searchable and may remain in third-party caches. Reading grants no membership or access to private channels. Sign in to report a post; joining requires the community’s usual invitation and onboarding.</p><ol aria-label="Public posts">${data.posts.map((p) => `<li><article><h2>${escapeHtml(p.authorName)}</h2><time datetime="${escapeHtml(new Date(p.createdAt).toISOString())}">${escapeHtml(new Date(p.createdAt).toISOString())}</time><p>${escapeHtml(p.content)}</p>${p.editedAt ? '<span class="muted">Edited</span> ' : ""}<a class="report" href="/public/${channelId}/report?message=${p.id}">Report post</a></article></li>`).join("")}</ol>${data.posts.length ? "" : "<p>No public posts on this page.</p>"}${data.next ? `<a class="pagination" href="/public/${channelId}?before=${data.next}">Older posts</a>` : ""}<footer><a href="/discover">All public channels</a></footer>`, `/public/${channelId}`);
}
