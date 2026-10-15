import { db } from "@/db";
import { assertSameOrigin } from "@/server/http";
import { AppError } from "@/server/errors";
import { publicReportTarget } from "@/server/public-channels";
import { escapeHtml, publicHtml, publicNotFound, publicOrigin } from "@/server/public-html";
import { reportContent } from "@/server/reports";
import { requireUser } from "@/server/session";
import { uuid } from "@/server/validation";

async function target(message: unknown, channelId: string) {
  const parsed = uuid.safeParse(message);
  if (!parsed.success) return null;
  const row = await publicReportTarget(db, parsed.data);
  if (!row || row.channelId !== channelId) return null;
  return parsed.data;
}
function signIn() { return new Response(null, { status: 303, headers: { Location: new URL("/sign-in", publicOrigin()).href, "Cache-Control": "private, no-store" } }); }
export async function GET(request: Request, ctx: RouteContext<"/public/[channelId]/report">) {
  const { channelId } = await ctx.params;
  const messageId = await target(new URL(request.url).searchParams.get("message"), channelId);
  if (!messageId) return publicNotFound();
  try { await requireUser(request.headers); } catch (error) {
    if (error instanceof AppError && error.code === "unauthorized") return signIn();
    if (error instanceof AppError) return publicNotFound();
    throw error;
  }
  return publicHtml("Report public post", `<h1>Report public post</h1><p>Your report is private to instance moderators. You do not need to join this community.</p><form method="post"><input type="hidden" name="messageId" value="${messageId}"><label for="reason">Reason (3–512 characters)</label><textarea id="reason" name="reason" required minlength="3" maxlength="512"></textarea><button type="submit">Submit report</button></form><p><a href="/public/${escapeHtml(channelId)}">Back to channel</a></p>`, `/public/${channelId}/report`);
}
export async function POST(request: Request, ctx: RouteContext<"/public/[channelId]/report">) {
  const { channelId } = await ctx.params;
  try {
    assertSameOrigin(request);
    const person = await requireUser(request.headers);
    // Native form is small; bound bytes before parsing rather than accepting a bulk upload.
    const body = await request.text();
    if (body.length > 4096) return publicNotFound();
    const form = new URLSearchParams(body);
    const messageId = await target(form.get("messageId"), channelId);
    if (!messageId) return publicNotFound();
    await reportContent(person.id, { messageId, reason: form.get("reason") });
    return publicHtml("Report submitted", `<h1>Report submitted</h1><p>Instance moderators can review your report.</p><a href="/public/${channelId}">Back to channel</a>`, `/public/${channelId}/report`);
  } catch (error) {
    if (error instanceof AppError && error.code === "unauthorized") return signIn();
    if (error instanceof AppError) return publicHtml("Report unavailable", `<h1>Report unavailable</h1><p>${escapeHtml(error.message)}</p><a href="/discover">Public channels</a>`, "/discover", 400);
    throw error;
  }
}
