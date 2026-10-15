# Native generation retirement experiment

This is a benign, isolated feasibility experiment against the pinned public
`@matrix-org/matrix-sdk-crypto-wasm` 18.9.0 API. It does not change the strict
application service, schema, routes, DM dispatcher or production behavior.

The normal test server extends the accepted ephemeral Voice fixture. An explicit
`retire` operation is separate from ordinary `send`. It processes the original
request, validates the current enrolled sender and generation, checks bounded
same-call UUID target syntax, records `processed-retired`, enqueues zero events
and returns its own actual native-shaped response. The dispatcher passes that
response to `markRequestAsSent` with the original native ID/type. It does not
rewrite the original body, flow, transaction ID or ciphertext. A separate random
receipt ID is stable for each immutable generation/operation/request tuple.

The fixture's fixed `.invalid` domain deliberately differs from deployment.
Its directory enrollment stands in for server authentication; this does not test
real cookie sessions, member secrets, leases, locks, HTTP serialization or DB
transactions. Those strict application checks remain untouched and need their
own later integration proof. The fixture has no browser, Worker or SFU, and
successful control decryption cannot establish actual media readiness.

Normal SAS is generated, compared and confirmed by both genuine native peers
using the existing test oracle. That oracle is not production user consent. A
new test-only sync adapter uses public `receiveSyncChanges` and validates native
sender/device, purpose and exact binding. Only a typed expected generation
interruption preserves its owner; native, cryptographic and schema errors remain
fatal. This avoids conflating the accepted fixture's generic disposal-on-any-
error policy with a native retirement API result.

The phase matrix pauses original request/ready/start/key/mac/done work from the
surviving owner. Cancellation uses public `VerificationRequest.cancel`; generated
cancel output and still-pending native ToDevice output receive real retirement
processing. Fresh SAS, retained independent-peer trust, immutable identity,
bounded queue drain and a real decrypted peer control are checked separately.
An old request can already have reached a peer: zero enqueue by retirement
never means historically never delivered. No retired receipt grants admission,
receipt, verification or media readiness.

Additional gates cover original Olm prekey-message nondelivery and subsequent
real peer traffic; empty current-scope query/claim responses; actual native
signature-upload refusal; late committed send responses; and an independent
memory-only DM machine. Empty claims do not manufacture sessions: the owner
does not loop when native requests another claim. Own KeysUpload always takes
the normal storage/count path and cannot use explicit retirement.

Signature refusal follows the official
[signature upload response schema](https://spec.matrix.org/latest/client-server-api/#post_matrixclientv3keyssignaturesupload):
`failures[user][key]` contains a standard Error. Refused current-scope storage
uses `M_FORBIDDEN`, not the cryptographic `M_INVALID_SIGNATURE`. No signature is
stored for that branch. Native response acceptance, queue behavior and unchanged
pre-response trust are distinct assertions; valid prior local SAS can already
have established trust before remote signature storage fails.

ToDevice send and retirement support exactly one user/device target. Multi-target
and wildcard output is rejected before any queue/receipt/native completion;
the owner suspends rather than splitting or rewriting it. The contract-only
rejection test does not manufacture a native queued request. This narrowed
candidate follows root's explicit fail-closed ruling. Query/claim/signature
multi-map semantics are separate. Genuine native two-user query and claim
requests are generated before a roster transition, then processed unchanged
with real current public keys/one prekey and empty departed results. The test
server owns an isolated public-key directory and real consumable prekey map;
there is no native/private state import. Exact retry checks prevent consuming
the current prekey twice. Actual mixed signature fanout depends on native
output and remains a separately reported gate. A
separate benign control schema does check recipient-side generation/epoch/exact
audience rejection after real decryption of an old fetched event. The accepted
shared control schema is unchanged. No constructed combined request is presented
as evidence of machine-owned queue semantics.

Remote CI is the only heavy execution environment. Initial RED results included
fixture owner disposal and attempting retirement as a removed sender; those
were fixture/artifact errors, not native protocol rejection evidence. Exact-head
results and any genuine SDK blocker must be recorded after remote execution.
