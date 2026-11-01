import { errorReportSchema } from "@/lib/error-report";
import { reportError } from "@/server/error-report";
import { AppError } from "@/server/errors";
import { assertSameOrigin, errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { consume } from "@/server/limits";
import { parse } from "@/server/validation";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AppError("invalid", "Send JSON.");
    if (!process.env.GLITCHTIP_DSN) return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
    // Public login/startup errors also need reporting. One shared cap bounds anonymous ingestion.
    await consume("error-report:browser", 60, 60_000);
    const report = parse(errorReportSchema, await readJsonBody(request, 4096));
    if (!report.source.startsWith("browser-")) throw new AppError("invalid", "Invalid error source.");
    await reportError(report);
    return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
