import type { Page } from "@playwright/test";

/** WebKit's protocol also labels handled network diagnostics as pageerror.
 * Observe the browser's actual error/rejection events, and retain protocol diagnostics separately.
 */
export async function collectRuntimeErrors(page: Page, errors: string[], diagnostics: string[] = []) {
  page.on("pageerror", (error) => diagnostics.push(error.message));
  await page.exposeFunction("__odReportRuntimeError", (message: string) => { errors.push(message); });
  await page.addInitScript(() => {
    const report = (window as Window & { __odReportRuntimeError: (message: string) => Promise<void> }).__odReportRuntimeError;
    const record = (message: string) => { void report(message).catch(() => { /* The document may have closed. */ }); };
    window.addEventListener("error", (event) => { if (event instanceof ErrorEvent) record(event.message); });
    window.addEventListener("unhandledrejection", (event) => {
      record(event.reason instanceof Error ? event.reason.message : String(event.reason));
    });
  });
}
