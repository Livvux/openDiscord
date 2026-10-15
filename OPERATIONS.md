
### Unactivated generation-room ownership (migration 0032)

The internal bound-token path reserves an exact `voice:<channel UUID>:<call UUID>:<generation>`
room in `voice_sfu_room` under the Voice transaction lock before any SFU create or JWT delivery.
`active` means authorized to issue, not proof a token was delivered or a room exists. Explicit
CreateRoom happens after commit; a second locked enrollment/generation check precedes JWT signing.
No network request is made inside the database transaction. Revocation can still race response
signing, admitted SFU requests, or late completion of a timed-out create. A retired generation is
terminal: retrying it never restores registration or returns a fresh token.

The call generation/status/delete trigger retires registered rooms atomically, including native
session/anchor/user cascades. Ownership has no parent foreign key and survives channel/community
removal. Cleanup claims due rows with a 30-second lease and a unique claim UUID; an expired worker
cannot overwrite a newer claim. Requests use the public SDK timeout **0.5 seconds**, with region
failover disabled, and run sequentially. Interactive consumption allows at most four rooms/four
requests and a 2.5-second RPC budget; maintenance allows at most sixteen rooms/32 requests and
20 seconds shared across lifecycle batches. Budgets include retries; failures are deferred durably,
not retried by timers. Fair ordering uses next-attempt time then exact name. Logs contain only
bounded aggregate counts/outcome categories. A missing room is successful cleanup only for the
SDK's actual `not_found` error. No list-all or prefix room discovery is performed.

Active ownership is checked independently from expired-call sweep eligibility, including current
call/generation, live account/session/anchor/lease, blocked pairs and channel permissions. Unknown
or overfull SFU rosters retire the whole owned room. This intentionally fails closed; the same
generation cannot be healed by issuing another token. Affected members must leave and enroll in
a fresh call generation through the normal control flow. Source permissions are narrowed from
current database authority, never from SFU metadata. This is eventual best-effort repair; neither
instant physical revocation nor prevention of all physical room resurrection is guaranteed.

Successful retired rows recur every five minutes when a consumer runs; active checks recur every
30 seconds. These are eligibility times, **not a scheduler**. The existing hosted maintenance
cadence must be monitored separately; an hourly job cannot promise five-minute cleanup. Inspect
count of due/leased/retired rows and oldest overdue time without exporting identities. SDK failure
or unavailable configuration must never undo a committed suspension, block, role loss or revoke.
The retained legacy channel-UUID room path remains separate, exact-name, best effort and is not
retroactively covered by generation ownership evidence.

The registry has a hard application admission cap of **100000 rows**. Only a new-room reservation
counts under the shared Voice lock; existing active reservations do not scan/count the table.
At capacity, new room grants fail closed for operator capacity review. Tombstones currently remain
indefinitely, so storage is proportional to generations that might ever have received a capability.
Do not prune after the app JWT expiry: pinned LiveKit 1.13.10 refreshes session tokens every five
minutes with at least ten minutes validity. There is no automatic tombstone GC or prune command.
Any later finite retention policy requires a separately reviewed SFU quiescence/recovery proof.

**Later coherent activation gate, not applied by this change:** pin and verify the actual SFU
1.13.10 image/digest, then set official `room.auto_create: false` only while all issuers/writers
are quiesced and the legacy UI/token bypass is coherently removed or migrated to explicit server
creation. Existing basic voice currently depends on auto-create. Product JWTs omit roomCreate and
roomAdmin. Run isolated real absent-room rejection, explicit-create acceptance and authenticated
three-browser/media acceptance before release. auto_create false is an admission barrier, not a
cross-system atomic fence against already validated joins or late create completion.
