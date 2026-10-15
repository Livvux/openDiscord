# Private messages

Direct conversations require a request and acceptance. Start a request from a community member's
message; there is no global account directory. Blocking either participant stops new messages and
cross-account encryption traffic. Existing local history is not erased by blocking.

## Trust and delivery

The browser runs `@matrix-org/matrix-sdk-crypto-wasm` **18.9.0**, whose reported native versions are
matrix-sdk-crypto **0.19.1** and vodozemac **0.11.0**. Olm protects device-to-device key delivery;
Megolm protects conversation events. Public account cross-signing and device keys are stored on the
application server. Device credentials authenticate uploads and mailbox access but are **not** the
E2EE keys; knowing a server API credential cannot decrypt message ciphertext.

Compare all three SAS numbers over a separate authenticated channel. Clicking the confirmation
means the numbers matched on both devices. Unknown devices prevent sending; no automatic local trust
or plaintext fallback is available. A new peer device needs either a trusted cross-signing identity or
fresh SAS verification. Revocation removes public device availability, prekeys and pending mailbox data.
The sender queries the roster before sending and rotates the outbound group session when it changes.
Revocation cannot revoke secrets or plaintext already delivered to a device, and does not cancel a
message already encrypted in an in-flight browser operation.

Each encrypted payload binds its conversation and client transaction. The SDK authenticates ciphertext and the sender; the client requires CrossSigned decryption and
a warning-free strict shield before displaying live text. Server-assigned event IDs are not signed
by Megolm. A durable local IndexedDB ledger additionally pins each conversation/sender/transaction
to its first accepted event ID and ciphertext, rejecting later duplicate envelopes. The ledger is
retained across reloads; a new browser cannot know events it never previously received. Server writes and device mailbox requests
are idempotent. A mailbox batch is acknowledged after SDK persistence. One-time prekeys are atomically
claimed, and consumed identifiers remain tombstoned so an upload retry cannot resurrect them.

The browser needs HTTPS (localhost is permitted), WebAssembly, IndexedDB and Web Locks. Only one tab
may own an account's crypto store at a time. Reload retains state; clearing browser storage loses
local keys. The IndexedDB store is encrypted, but its unlocking secret resides in the same browser
origin. This protects neither against a compromised browser nor against code running in that origin.

## Additional devices and recovery

A new browser enrolls a distinct device. Verify it against an existing trusted device using SAS and
choose **Share identity and history**, or open a previously downloaded private recovery file.
Device sharing uses an authenticated, encrypted Olm event and is limited to verified devices on the
same account. Each transfer is saved in an encrypted local outbox before sending. The receiver sends
an authenticated receipt only after committing the archive to browser storage. Until that receipt
arrives, the sender retries with a fresh Olm message and the same transfer ID, including after reload;
this recovers a consumed Olm delivery if the receiver crashed or ran out of storage. Import tombstones
prevent duplicate archive writes. Three transfers may remain pending, with eight automatic attempts
and a backoff capped at one minute. The interface shows pending or paused delivery and permits retry
or **Stop transfer retries**. Stopping retries cannot recall a delivery already sent. The
sender's browser must be open to retry. Large snapshots use the encrypted backup path instead.

**Create encrypted recovery backup** exports the SDK's cross-signing secrets together with a bounded
history archive. The archive contains the most recent **up to 200 messages loaded and authenticated by this
browser**, bounded to 3.5 MB of serialized source copies, with their complete ciphertext envelopes and source-verification dates. Load earlier
messages before backing up if those are needed. It does not promise to include unread messages or
every historical conversation. Source/device fingerprint, account, original web origin, backup ID and
format version are bound inside the encrypted snapshot.

The browser encrypts the snapshot using the SDK's Matrix attachment format (AES-CTR with SHA-256
integrity). This is not an AEAD format: its key, IV and expected hash must stay together in the trusted
user-held recovery file, or inside an authenticated own-device Olm event. The server receives only
ciphertext. Neither missing hashes nor server-provided replacement encryption metadata are accepted.
Keep the private recovery file outside the browser. Restoring requires that file, its server ciphertext
backup and account access on the original origin. Deleting a server backup makes its recovery file
unusable. There are at most ten backups per account, each at most 4 MB before base64 encoding.

Opening a recovery file creates a **separate read-only archive**. It does not import arbitrary room keys
as trusted live sessions, and does not give archive copies a current SDK verification badge. Upstream
`exportRoomKeys`/`importExportedRoomKeys` loses the authenticated sender provenance: a strict SDK
probe rejects those imported sessions even when the original session is verified. The archived copies
were authenticated on the source device before backup; their event IDs and delivery timestamps remain
server-supplied metadata, not cryptographic delivery-time evidence. Archive IDs are deduplicated and
imports never replace another archive or live message history.

**Restore current encryption identity** is a separate explicit action. It derives the recovery bundle's
public identity in an isolated SDK store and requires it to match the current account master key before
changing the live SDK state. An archive from a previous identity remains readable but cannot silently
replace the current identity. New live sessions still require the normal SDK authentication path.
Incoming own-device transfers also require this explicit identity action. Pending identity bundles are
encrypted in browser storage and committed atomically with the archive and import marker. Reload
retains the pending identity action. The pending bundle is removed after successful explicit restore
or when its local archive is deleted; it is never implicitly installed as the current identity.

Local verified-copy caches and recovered archives are stored as encrypted attachments in IndexedDB,
with unlocking information in the same browser origin. This is not protection against endpoint or
same-origin code compromise. At most ten local archives and 200 source-cache messages (3.5 MB total) are retained;
local archives can be removed separately from server backups. Future backups include the current
browser's verified-copy cache, not automatically every previously recovered archive.

Account password reset cannot recover encryption secrets. Losing every trusted device and recovery
file loses the corresponding history. An unavailable browser store can be explicitly re-enrolled;
this revokes the previous device and requires trust enrollment again. Clearing browser storage also
removes the local replay ledger and recovered archives.

**Reset lost encryption identity** is an explicit destructive recovery option when no trusted device
or recovery file remains. It requires a session created within the past five minutes, confirmation
of the current account password and a current authenticator code when two-factor authentication is
enabled. The server checks that the confirmed identity and two-factor setting have not changed, then
atomically revokes all encryption devices, removes public identity/signatures, prekeys, pending
mailboxes and encrypted server backups, and signs out every account session, including the resetting
browser. Session ownership is checked again inside the crypto transaction lock, so queued requests
from revoked sessions cannot register devices or upload a replacement identity. Existing ciphertext
messages remain ciphertext. Sign in again to enroll a fresh identity; contacts must verify it
again. This cannot recover the old history or erase copies already held elsewhere. Old local stores
are not reused by the new identity; reset does not claim secure erasure of browser storage.

## Server visibility and reporting

The server sees participants, device public keys, conversation state, envelope sizes and timestamps.
It can refuse delivery or hide devices. This is not metadata-hiding messaging, key transparency or
an externally audited application. The web application is delivered by the operator: an operator or
attacker able to replace that code can obtain plaintext in the browser. E2EE protects content from
passive server/database access when users receive and run the honest client. It cannot secure an
already compromised endpoint or promise trust in a maliciously modified web application.

Direct messages do not appear in community search, bots, webhooks, notifications with plaintext,
public APIs or server moderation history. A recipient can report a message and explicitly choose
whether to disclose its text. A report reason is always plaintext. Moderators see only the reason and
selected excerpt; excerpts are recipient statements and cannot be independently authenticated by the
server. Review is restricted to active instance administrators and is audited.

Account export version 6 includes conversation metadata, device metadata, public identity, ciphertext
messages, ciphertext backups and the caller's reports. It never includes device bearer secrets or
browser private keys. Account deletion cascades device keys, mailbox contents, backups, conversation
ciphertext and related reports. Previously downloaded plaintext, private recovery files and other
participants' local browser copies cannot be remotely erased.

## Operational limits and evidence

Limits: ten active devices, 500 conversations initiated within the account's checked conversation
cap, 4,000-character messages, 24,000-character message ciphertext, 256 pending events per device (large encrypted own-device transfers require fewer than 16 pending
events),
8 KB per peer device event, 40 device deliveries per crypto operation, 100 available one-time prekeys and 100,000 lifetime prekey
or transaction entries per device. Enroll a replacement device when a lifetime limit is reached.
Target account/device counts and signing payload sizes are checked before database locks. A short
global database transaction lock serializes claims, receipts and mailbox sequence commits. This is a
throughput limit, chosen to make cursor ordering exact on the current single-instance deployment;
there is no network work inside the critical section. Scaling requires measured mailbox partitioning
with the same commit/cursor guarantees.

Dependency evidence and audit boundaries:

- [Pinned WASM release](https://github.com/matrix-org/matrix-sdk-crypto-wasm/releases/tag/v18.9.0)
- [Generated API reference](https://matrix-org.github.io/matrix-sdk-crypto-wasm/)
- [Maintained Rust crypto source](https://github.com/matrix-org/matrix-rust-sdk/tree/main/crates/matrix-sdk-crypto)
- [vodozemac and its audit reference](https://github.com/matrix-org/vodozemac)
- [Matrix client/server encryption and SAS specification](https://spec.matrix.org/latest/client-server-api/#end-to-end-encryption)

Automated coverage is maintained in `tests/dm-crypto.test.ts`, `tests/dm-matrix.integration.test.ts`,
`tests/direct-messages.integration.test.ts`, `tests/dm-reset.integration.test.ts` and
`e2e/direct-messages.spec.ts`; passing results must be checked on the exact release commit. Tests and
upstream library audits do not replace an independent review of this integration.
