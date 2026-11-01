import { config } from "zod/v4/core";
import { sanitizedError } from "./lib/error-report-client";

// The CSP has no 'unsafe-eval', so zod's JIT can never run in the browser. Without this,
// its Function("") probe is blocked on every page and Firefox logs a CSP violation.
config({ jitless: true });

let reports = 0;
const report = (error: unknown, source: "browser-error" | "browser-rejection") => {
  if (reports >= 3) return;
  reports += 1;
  void fetch("/api/error-report", { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sanitizedError(error, source, location.origin)), keepalive: true,
  }).catch(() => {});
};
window.addEventListener("error", (event) => { if (event.error) report(event.error, "browser-error"); });
window.addEventListener("unhandledrejection", (event) => report(event.reason, "browser-rejection"));
