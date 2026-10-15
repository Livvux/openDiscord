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
- [x] Run focused tests remotely, lint/typecheck/build and existing SSE/auth integration/E2E checks.
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
- [x] Test unauthenticated/stale-session/duplicate-address/confirmation flows, plus desktop and mobile settings. SMTP-enabled real-inbox acceptance remains separate.
- [x] Review and commit.

### Task 4: Operational release evidence

- [x] Add minimal readiness checks and protected/operator maintenance execution.
- [x] Configure production scheduling, encrypted off-host backups and alerts, with backups and reversible changes.
- [x] Rehearse production-data restore remotely in isolation.
- [ ] Validate TURN and physical-device acceptance separately.
- [x] Deploy verified increments #29, #31, #32 and #33; verify public edge and runtime revision. Future increments retain this gate.

### Task 5: Community trust

- [x] Design and implement scoped onboarding/rules and ban explanations/appeals with permission tests and UI flows.
- [x] Publish factual operator policies and 16-year self-attestation; external legal review remains open.

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

- [PR #29](https://github.com/Livvux/openDiscord/pull/29): shared counters/leases (0023), retention, coarse device labels, verified email correction, readiness, encrypted CI restore rehearsal, license declarations and community rules/appeals (0024). Browser acceptance caught form-submit and navigation defects; these were corrected before exact-head CI 38770569738 passed at 5429508. Merged as 84e94ca and deployed.
- [PR #31](https://github.com/Livvux/openDiscord/pull/31): funding and governance, operator-reported EUR250/month and the operator's GitHub Sponsors URL. Exact-head CI 38771691377 passed at 3b96a4f; merged as 0fc06d8. Public desktop browser and CI mobile/desktop checks passed.
- [PR #32](https://github.com/Livvux/openDiscord/pull/32): private filesystem/S3 attachment abstraction and optional fail-closed ClamAV protocol integration. Exact-head CI 38772166696 passed at fd62bec, including actual authenticated attachment browser round trips. Merged as bcd84ef and deployed. Production still uses private R2; no production scanner is configured. Scanner tests use a protocol simulator, not a signature engine.
- [PR #33](https://github.com/Livvux/openDiscord/pull/33): bounded maintenance lifecycle, external health/backup alert jobs and automatic Dokploy environment-file permissions. Exact-head CI 38774365244 passed at 3721181; merged and deployed as 4ee3d46. Live systemd job results and automatic mode0600 after redeploy verified.
- Production encrypted off-host backup readback matched SHA-256; private bucket, 30-day lifecycle and daily timer configured. Two real isolated production-data restores succeeded; the post-release archive restored 34 public tables and 25 migrations. That archive had zero attachment references, so it does not prove restoration of existing media. Temporary database, recovery-key input and probe user were removed.
- Public health/readiness return 200. Maintenance is scheduled hourly; its first apply minimized one legacy session's metadata and deleted no active records. Health and backup failure/staleness monitors run on separate hosts; SMTP accepted test notifications to the existing operator address. Inbox delivery is not proven by SMTP acceptance alone.
- Cloudflare configuration now disables injected RUM only for opendiscord.app. API readback and live browser DOM/network checks on funding and sign-in found no Cloudflare Analytics script/request after propagation; CSP was not relaxed.
- [PR #34](https://github.com/Livvux/openDiscord/pull/34): operator-approved public policies and 16-year signup self-attestation. Exact-head CI 38778505661 passed at 77ffba8; merged and deployed as 90920fe. Public browser verified approved operator details and the required age checkbox; ready200 and environment mode0600. No date of birth or identity document is collected. External legal review remains open.
- [PR #30](https://github.com/Livvux/openDiscord/pull/30): encrypted DMs with Matrix crypto WASM18.9.0 are still in implementation and runtime verification. No plaintext fallback or completed/audited E2EE claim is made. Voice E2EE has not shipped.
- SMTP-disabled settings behavior is browser-covered; SMTP-enabled real-inbox delivery, TURN, physical-device voice and push delivery remain separate acceptance checks.
