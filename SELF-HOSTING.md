
### Generation-room ledger backup and activation boundary

Migration 0032 adds durable SFU ownership; the ordinary full PostgreSQL backup/restore includes
`voice_sfu_room`, and readiness probes every exported ledger column. The CI encrypted restore
rehearsal compares every table, including this ledger. Preserve this table during code rollback.
Do not resume token issuers from old code that does not register ownership. Restoring a pre-0032
backup while SFU rooms survive loses ownership evidence: keep admissions/issuers stopped until
an explicitly approved, isolated SFU drain/reset or a matching ledger backup restores consistency.
Never discover/delete arbitrary shared SFU rooms by prefix, and never delete ownership rows merely
because app tokens expired. Use the 0031 quiesced-writer upgrade/rollback gate above as well.

The new internal token path explicitly creates registered generation rooms after database commit
and revalidates before signing. It does not activate the product transport or change LiveKit
configuration. A later coherent release must verify pinned LiveKit 1.13.10 `room.auto_create: false`
with actual runtime acceptance, and retire the legacy auto-created channel-room issuers together.
See OPERATIONS for cleanup budgets, indefinite tombstone retention, the 100000-row admission cap,
capacity review and physical revocation/race limitations.
