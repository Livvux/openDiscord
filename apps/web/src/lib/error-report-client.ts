import type { ErrorReport } from "./error-report";

export const ERROR_TYPES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "DOMException"] as const;
export const STATIC_SCRIPT_PATH = /^\/_next\/static\/[A-Za-z0-9/_.-]+\.js$/;

/** Keep this module free of runtime Zod imports: client instrumentation sets jitless first. */
export function sanitizedError(error: unknown, source: ErrorReport["source"], origin?: string): ErrorReport {
  const name = error instanceof Error ? error.name : "Error";
  const type = ERROR_TYPES.find((value) => value === name) ?? "Error";
  const frames: ErrorReport["frames"] = [];
  if (origin && error instanceof Error) {
    for (const line of (error.stack ?? "").split("\n").slice(0, 30)) {
      if (!/^\s*at\s|^[^\s]*@https?:\/\//.test(line)) continue;
      const match = line.match(/(https?:\/\/[^\s()]+):(\d+):(\d+)\)?$/);
      if (!match) continue;
      try {
        const url = new URL(match[1]);
        const frame = { filename: url.pathname, lineno: Number(match[2]), colno: Number(match[3]) };
        if (url.origin === origin && !url.search && !url.hash && frame.filename.length <= 240 && STATIC_SCRIPT_PATH.test(frame.filename)
          && Number.isInteger(frame.lineno) && frame.lineno > 0 && frame.lineno <= 10_000_000
          && Number.isInteger(frame.colno) && frame.colno > 0 && frame.colno <= 10_000_000) frames.push(frame);
      } catch { /* Ignore unsupported stack-frame formats. */ }
      if (frames.length === 12) break;
    }
  }
  return { source, type, frames };
}
