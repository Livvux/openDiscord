# Bounded native generation feasibility proof

Test-only candidate, based on the independently reviewed 2026-10-16 design. No
application service, route, schema, dependency or browser media behavior changes.

1. Write native SDK tests before the fixture. Pause genuine outgoing SAS at
   request/ready/start/key/mac/done, cancel through public APIs, process explicit
   server retirement and inspect native pending work and fresh peer verification.
2. Keep original native id/type/body. A separate receipt identity binds operation
   and generation. Current authorization precedes retry lookup. Complete each
   native request once, including when an old response arrives late.
3. Exercise first Olm message nondelivery, genuine empty query/claim responses,
   officially shaped signature failures and an independent DM baseline. Report
   API failures as blockers, without private queue access or synthetic success.
4. Use the existing remote draft-PR CI for lint, typecheck, native tests, build,
   browser suite and Docker. No local heavy verification.

Independent review question: do class-specific real processed responses preserve
truthful nondelivery and exactly-once native processing without certifying peer
receipt, SAS completion or media admission? Initial conditional review permits
this isolated experiment only. Any uncovered class remains a rollout blocker.
