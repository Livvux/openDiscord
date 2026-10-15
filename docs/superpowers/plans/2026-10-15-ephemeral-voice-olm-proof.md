# Ephemeral voice Olm proof plan

Scope: specs/2026-10-15-ephemeral-voice-olm-proof.md; base origin/main bf3dc34, isolated worktree opendiscord-voice-ephemeral, branch test/ephemeral-voice-olm. No existing DM/voice product file ownership.

1. Verify pinned SDK APIs and memory-only initialization; retain frozen lockfile. Done by source/type inspection and `pnpm install --frozen-lockfile`.
2. Add a test-only bounded transport/owner fixture using exact native request response shapes. No production server fallback or general crypto abstraction.
3. Add executable three-device native SAS/control and independent DM-baseline lifecycle checks using normal valid messages. Native crypto unchanged, no key/material logging.
4. Run targeted local lint/discovery only; canonical typecheck/unit/integration/build/browser tests remote CI. Open/register draft PR immediately after first meaningful push; inspect exact-head failures.
5. Independent security and TypeScript review coordinated by root. Record supported native evidence separately from later real three-device media acceptance and product authorization.

Product work is gated. Any unsupported SDK behavior stops this scope for review; it cannot be replaced by setLocalTrust, raw cryptography, DM-store sharing or silently broader DM consent.
