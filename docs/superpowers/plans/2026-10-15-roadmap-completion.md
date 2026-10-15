# Roadmap Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete and verify the remaining openDiscord roadmap without overstating audit, encryption or release guarantees.
**Architecture:** Retain the application and PostgreSQL architecture. Deliver independently reviewable increments, starting with safety and operations before new private communication systems.
**Tech Stack:** Next.js 16, PostgreSQL 18, Drizzle, Better Auth, LiveKit, pnpm.
**Spec:** docs/superpowers/specs/2026-10-15-roadmap-completion-design.md

## Global Constraints

- Preserve the existing Next.js/Postgres architecture, flat UI and pnpm lockfile.
- No custom cryptographic protocols or plaintext DM shortcut.
- Heavy checks use remote isolated CI; no production database for tests.
- Keep external audit, legal review and physical-device evidence explicit.

## Review Focus

- Concurrent counter/lease acquisition across processes must enforce one cap.
- Stream cancellation before setup finishes must not leak slots or listeners.
- Failed maintenance must not delete active credentials or open reports.
- Email changes must not bypass confirmation or SMTP requirements.
- Media encryption must authenticate the participants and keep keys from the operator.

### Task 1: Shared abuse controls

**Files:** server/limits.ts, server/rate-limit-store.ts, new server/stream-leases.ts, db/instance-schema.ts, generated migration; all consume callers; both SSE routes; focused integration tests.
**Interfaces:** `consume` becomes async; every caller awaits it. `acquireStreamLease(userId, scope)` returns an idempotent async release function. Scope preserves the existing personal/community independent caps, each 8 per user. Lease expires after the existing ten-minute maximum connection lifetime plus a short cleanup allowance; a dead process cannot permanently occupy a slot.

- [x] Write concurrent rate-counter and lease-cap tests, expiry and idempotent-release tests.
- [x] Implement atomic Postgres limits and leases with no new dependency; update all callers and existing limiter tests.
- [x] Generate migration through drizzle-kit; check generated SQL and metadata.
- [ ] Run focused tests remotely, lint/typecheck/build and existing SSE/auth integration/E2E checks.
- [x] Review and commit the increment.

### Task 2: Retention and minimized session metadata

**Files:** new server/maintenance.ts and scripts/maintenance.ts; auth.ts session hook; focused integration tests; PRIVACY.md and SELF-HOSTING.md.
**Interfaces:** dry-run by default, explicit apply option; fixed reference time per run; 180-day audit/resolved-report retention, one-day rate-window retention. Batches avoid unbounded delete transactions. Return aggregate counts only.

- [x] Test cutoff boundaries, active sessions, open reports, dry-run and repeated runs.
- [x] Implement maintenance and coarse session labels; preserve current auth behavior.
- [x] Run remote checks; document scheduling and backup safety; review and commit.

### Task 3: Verified email change

- [x] Verify installed Better Auth source/types and official documentation.
- [x] Implement SMTP-gated current-address confirmation/new-address verification and settings UI.
- [ ] Test unauthenticated/stale-session/duplicate-address/confirmation flows, plus desktop and mobile settings.
- [x] Review and commit.

### Task 4: Operational release evidence

- [x] Add minimal readiness checks and protected/operator maintenance execution.
- [ ] Configure production scheduling, encrypted off-host backups and alerts, with backups and reversible changes.
- [ ] Rehearse restore remotely in isolation; validate TURN and separate physical-device acceptance.
- [ ] Deploy only verified increments, verify public edge and runtime revision.

### Task 5: Community trust

- [ ] Design and implement scoped onboarding/rules and ban explanations/appeals with permission tests and UI flows.
- [ ] Publish factual operator policies; track external legal review separately.

### Task 6: DMs and authenticated E2EE

- [x] Produce an evidence-backed crypto integration decision and executable feasibility test.
- [ ] Implement requests, membership, blocking/reporting and encrypted multi-device transport, verification and recovery.
- [ ] Verify server ciphertext-only behavior, revocation, replay boundaries and recovery; obtain independent audit before an audited claim.
- [ ] Implement and verify voice E2EE participant key distribution separately.

### Task 7: Remaining product roadmap

- [ ] Implement and verify local attachments/scanning, attachment-complete exports, mobile/accessibility and measured scaling.
- [ ] Implement custom emoji/stickers and explicit public channels/discovery; deliver native clients with signing requirements accounted for.
- [ ] Complete governance/license checks and cost-backed funding disclosure; record federation research conclusions.

## Evidence ledger

- Baseline: main 9a196db; CI green in GitHub. LiveKit production has working UDP and TCP synthetic browser media; real-device/app-account acceptance remains open.
- Ruling: user authorization covers implementation and safe production rollout; do not repeatedly request permission for reversible work. External professional reviews cannot be simulated.

### Release increment evidence (2026-10-15)

- PR #29 contains shared counters/leases (0023), bounded retention, coarse device labels, verified email correction, readiness checks, encrypted CI restore rehearsal, dependency-license declarations, and community rules/appeals (0024).
- Independent implementation, security and final integration reviews approved the code through d7a8859. Export/import rules and private moderation-data portability were corrected during review.
- Remote CI at d7a8859 passed lint, types, migrations, unit/integration tests, encrypted restore rehearsal, production build and Docker build. Community desktop/mobile browser acceptance exposed form-submit and navigation synchronization defects; fixes and a fresh exact-head run remain required before release.
- Production: encrypted off-host backup uploaded, complete ciphertext readback matched SHA-256, private bucket lifecycle and daily timer configured. No production-data restore success is claimed: the isolated restore is prepared but the separately stored recovery key awaits 1Password authorization.
- Production maintenance scheduling and deployment of PR #29 remain pending. CI restore uses disposable fixtures; it does not substitute for the production-data restore.
- SMTP-disabled settings behavior is browser-covered; SMTP-enabled delivery and physical-device voice/push acceptance remain separate checks.
- DMs are in implementation with Matrix crypto WASM 18.9.0. No plaintext fallback or completed/audited E2EE claim is made. Voice E2EE has not shipped.
