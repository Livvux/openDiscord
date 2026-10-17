# Unreleased stacked Voice lifecycle implementation

Base: e14c2d1220e68ea7f7a1726fa60adc9b24ed53dd, PR54 server draft.
Authoritative design: /tmp/opendiscord-voice-lifecycle-integration-brief.md including all appendices, security preflight and auth statement-guard decision.

1. RED: PostgreSQL tests for native cascade generation and rollback, guard order and empty-call repair. Execute through draft PR remote CI before implementation.
2. Ordered seven-table statement guards and member deletion backstop in exclusive migration0031; no existing migration edits.
3. Narrow canonical Voice/mixed lock entry, scoped invalidation, capability-loss comparisons, blocked-pair closure and bounded keyset sweep.
4. Wire actual community/moderation/block/admin/anchor/reset/integration mutations, bootstrap and maintenance prelocks atomically.
5. Real native adapter and pg_locks-barrier concurrency tests, maintenance progress and scoped mutation regression coverage.
6. Remote complete CI, independent security/database/TypeScript review coordinated by root. No merge, deploy, public routes/tokens/UI or runtime activation.

Heavy builds/typechecks/tests/Docker run only remote CI. Dependency policy: frozen pnpm install, no new dependencies or lockfile changes. Existing basic Voice is not claimed encrypted; SFU effects must remain inert until compatible runtime activation.
