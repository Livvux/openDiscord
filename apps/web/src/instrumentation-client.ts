import { config } from "zod/v4/core";

// The CSP has no 'unsafe-eval', so zod's JIT can never run in the browser. Without this,
// its Function("") probe is blocked on every page and Firefox logs a CSP violation.
config({ jitless: true });
