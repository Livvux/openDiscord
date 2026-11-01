import { z } from "zod";
import { ERROR_TYPES, STATIC_SCRIPT_PATH } from "./error-report-client";

export const errorReportSchema = z.object({
  source: z.enum(["browser-error", "browser-rejection", "server-render", "server-route", "server-action", "server-proxy"]),
  type: z.enum(ERROR_TYPES),
  frames: z.array(z.object({
    filename: z.string().regex(STATIC_SCRIPT_PATH).max(240),
    lineno: z.number().int().min(1).max(10_000_000),
    colno: z.number().int().min(1).max(10_000_000),
  }).strict()).max(12),
}).strict();
export type ErrorReport = z.infer<typeof errorReportSchema>;
