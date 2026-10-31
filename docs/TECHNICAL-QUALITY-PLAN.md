# Technical quality milestones

Baseline: source revision `791b769`, reviewed 2026-10-29. This plan separates implementation,
executed acceptance, release and independent review. It does not claim Discord-scale capacity.

| Order | Milestone | Required evidence |
| --- | --- | --- |
| 1 | Enforced validation and reliable community sends | Active workflows and protected `check`, `voice-product`, `real-engine`; concurrent retry deduplication; rollback on notification failure; deletion tombstones; fresh authorization on replay; desktop/mobile lost-response and rejected-attachment browser flows |
| 2 | Durable delivery and operational visibility | Decide an explicit retry retention window and storage policy; encrypted persistent pending sends; idempotent integration/webhook sends; transactional events for remaining mutations; durable push jobs; bounded SSE slow-consumer behavior; privacy-preserving latency/error/reconnect metrics |
| 3 | Voice continuity and media quality | Reviewed encryption-compatible network handover and reconnect; real restrictive-network/TURN tests; larger calls; screen audio; evaluated codecs, simulcast and packet-loss handling; device routing and interruption tests; call-quality metrics |
| 4 | Mobile calling and notifications | Real iOS/Android acceptance; background/locked-screen calls; CallKit and Android foreground-service integration; native notification delivery; Bluetooth routing; documented supported OS/device matrix |
| 5 | Encrypted messaging continuity | Multi-tab coordination without concurrent crypto-store writers; scalable authenticated history recovery; device onboarding; browser-storage-loss tests; persistent local search index with explicit encrypted-storage and eviction policies |
| 6 | Measured deployment capacity and recovery | Repeatable multi-replica load/soak and fault tests; client CPU/RAM/scroll measurements; lock contention and SSE query/fan-out profiling; supported deployment sizes; latency/availability targets; measured backup recovery and failover objectives |
| 7 | Independent assurance | External cryptographic integration review and authenticated pentest on an exact release revision; resolve findings; physical-device and assistive-technology acceptance; independent legal/privacy/license review remains separately assigned |
| 8 | Trusted desktop and broader integrations | Operator-owned signing keys/certificates; signed/notarized installers and tested update/rotation paths; platform acceptance; structured permission-aware search; reviewed outgoing event/integration model |

## First implementation boundary

`0044_message_send_receipts` adds per-author send IDs with payload fingerprints and deletion
tombstones. Community message creation and mention events use transactional PostgreSQL notifications.
The browser keeps ambiguous attempts in a tab-scoped `sessionStorage` outbox for an explicit identical
retry; expected first-send rejections restore the editable draft and keep attachments available. The bot API accepts optional
send IDs. Receipts are included in user-export version 13 and cascade with their channel or account.

Unconfirmed community sends survive in-app navigation and reloads of the same tab (`od.outbox.v1:<userId>`,
24 hours, at most 20 per user, cleared on tab close and sign-out; D14). Restored entries are never
sent automatically: Retry reuses the send ID, a coded server refusal is final (Edit/Discard). Drafts
(channel, thread, DM) are in memory only and lost on reload by design. Entries for a channel that has
become inaccessible are not shown (the page 404s) and expire with the TTL or tab.

This does not provide a cross-tab or cross-device offline outbox, exactly-once end-to-end delivery,
durable event replay, guaranteed push delivery, persistent DM sends, or idempotent reaction
toggles/webhook sends. Do not enable automatic retries for non-idempotent mutations.

## Validation environment and release constraints

The first candidate was validated in an isolated Linux VM with Node 24.21, pnpm 12.9.1,
PostgreSQL 18 and LiveKit 1.13: frozen install, fresh migrations, typecheck, production build,
all 125 backend test files (1,073 passed, 7 skipped), and production dependency audit passed.
ESLint reported zero errors and one existing warning in unchanged `use-channel-messages.ts`.
The lost-response and rejected-reply/attachment browser journeys passed in Chromium desktop
and Pixel 7 emulation without retries. Browser assertions cover stored-message uniqueness,
reused request payload, editable rejected drafts, retained files, runtime/console errors and
responsive overflow. These checks do not replace the remaining CI workflows, physical-device
acceptance or production deployment/readback. Internal code and TypeScript reviews were completed.

On 2026-10-29 all seven project workflows were manually disabled and `main` required no status checks.
They were re-enabled and strict required checks restored. GitHub subsequently reported that jobs could
not start because the account was locked due to billing; activation alone does not establish green CI.
Keep the checks enforced and resolve the account issue without bypassing protection.
Only `Livvux` currently has collaborator write access. Distinct-person GitHub approval remains
unenforced (required approvals: zero); add an eligible independent reviewer before requiring it.
Agent code review is not a substitute for that approval or an external security audit.

The initial audit incorrectly called the Voice maintenance shard unreachable. It belongs to the browser
matrix `[1, 2, 3]`, so `matrix.shard == 3` was already valid; no shard change is required.

Manual validation must use an isolated environment on `webserver` under the guest `flock`, preserve
existing VM data and avoid the production Docker daemon. Do not allocate more host disk while its
reserve is exhausted. Signing credentials, paid services and external review require the responsible
operator/provider; source changes cannot supply those proofs.
