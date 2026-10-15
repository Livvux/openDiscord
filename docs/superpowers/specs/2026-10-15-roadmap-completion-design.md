# Roadmap completion design

The user authorized completing the remaining roadmap, including production delivery. Work is incremental: no item becomes complete until its acceptance evidence exists. The target is the current ROADMAP.md plus the gaps discussed in the conversation, not an unbounded claim of full Discord parity.

## Constraints

Keep Next.js, PostgreSQL 18, Drizzle, Better Auth and the flat existing UI. Use pnpm and the frozen lockfile. Do not introduce custom cryptographic protocols. Community messages remain explicitly non-E2EE. DM and voice E2EE require device authentication and membership-bound key distribution; server-issued shared secrets alone are not E2EE against the operator. External audits, legal review, real-device checks and operator cost inputs must remain explicit external acceptance gates.

## Delivery order and acceptance

1. Shared abuse controls: mutation/read/upload/API counters use atomic PostgreSQL operations; SSE slots use expiring shared leases, released on close and bounded after process failure. Concurrent requests cannot exceed caps across replicas. Preserve existing limits and HTTP error behavior.
2. Retention and session privacy: an operator-invoked maintenance command purges expired sessions and verification records, old rate windows, expired stream leases, community and instance audit rows older than 180 days, and resolved abuse reports older than 180 days. Open reports and active sessions survive. Support dry run and bounded batches; no user content purge. Store only a coarse browser/platform label for sessions, never raw UA/IP. Existing session metadata is minimized by maintenance.
3. Verified email correction: Better Auth's supported email-change flow, confirmation to current verified address and verification of new address; unavailable without SMTP. Account settings expose the flow and explain verification. Never update email directly in application SQL.
4. Operational acceptance: health/readiness endpoint without sensitive data, scheduled maintenance and encrypted off-host backups, restore rehearsal in an isolated environment, alerts, rollout/rollback evidence. Complete media traversal with TURN and real-device acceptance; automated synthetic tests are separate evidence.
5. Community trust: rules/onboarding, member-facing restrictions and appeals with scoped moderator review, retention and audit. Operator rules must distinguish technical policy from externally reviewed legal terms.
6. Private communications: validate maintained audited crypto components, then implement DMs with requests/blocking/reporting, device keys, verification, multi-device delivery and recovery. No plaintext DM shortcut. Voice E2EE has separate key distribution and device verification acceptance.
7. Remaining product scope: local/private attachment storage, optional scanner, attachment-complete export/import, mobile flows, accessibility, load characterization, custom emoji/stickers, native client delivery, public opt-in channels/discovery. Federation remains research until a supported protocol and abuse boundaries are proven. Governance, license checks and real-cost funding disclosure have their own evidence.

## External acceptance boundaries

A passing CI is not an external security audit, legal approval, physical-device test or a proof of production recovery. Do not mark these complete using mocks, generated legal claims, assumed costs or documentation alone.
