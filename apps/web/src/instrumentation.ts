import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("./server/media")).startMediaSweeper();
}

export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportError } = await import("./server/error-report");
  const { sanitizedError } = await import("./lib/error-report-client");
  const source = context.routeType === "action" ? "server-action" : context.routeType === "route" ? "server-route" : context.routeType === "proxy" ? "server-proxy" : "server-render";
  await reportError(sanitizedError(error, source));
};
