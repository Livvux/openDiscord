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

Each encrypted payload binds its conversation and client transaction. The SDK authenticates the
sender and detects invalid ciphertext/replays; the application additionally verifies these bindings
and the sender's verified device before rendering text. Server writes and device mailbox requests
are idempotent. A mailbox batch is acknowledged after SDK persistence. One-time prekeys are atomically
claimed, and consumed identifiers remain tombstoned so an upload retry cannot resurrect them.

The browser needs HTTPS (localhost is permitted), WebAssembly, IndexedDB and Web Locks. Only one tab
may own an account's crypto store at a time. Reload retains state; clearing browser storage loses
local keys. The IndexedDB store is encrypted, but its unlocking secret resides in the same browser
origin. This protects neither against a compromised browser nor against code running in that origin.

## Additional devices and recovery

A new browser enrolls a distinct device. Verify it against an existing trusted device using SAS and
choose **Share identity and history**, or import a previously downloaded private recovery file.
Device sharing uses an authenticated, encrypted Olm event and is limited to verified devices on the
same account. Large histories use the encrypted backup path instead.

**Create encrypted recovery backup** exports the SDK's cross-signing secrets and room keys locally,
then encrypts that snapshot using the SDK's Matrix attachment encryption. The server receives only
ciphertext. Download the separate private recovery file: its encryption information is never uploaded.
Keep it private and outside the browser. Restoring requires both this file and the corresponding
server backup, plus access to your account. The file provides integrity information for the ciphertext;
changing encrypted backup bytes makes restoration fail. Deleting a server backup makes that recovery
file unusable. There are at most ten backups per account, each at most 4 MB before base64 encoding.

Identity recovery and history recovery are distinct: a snapshot restores the identity and only the
room keys included when it was created. Later keys require a newer backup or a trusted existing
device. Account password reset does not recover E2EE secrets. Losing every trusted device and every
recovery file loses the corresponding history. An unavailable browser store can be explicitly
re-enrolled; this revokes the previous device and requires trust enrollment again.

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
cap, 4,000-character messages, 24,000-character message ciphertext, 2,000 pending events per device,
40 device deliveries per crypto operation, 100 available one-time prekeys and 100,000 lifetime prekey
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

Automated coverage is maintained in `tests/dm-crypto.test.ts`, `tests/direct-messages.integration.test.ts` and
`e2e/direct-messages.spec.ts`; passing results must be checked on the exact release commit. Tests and
upstream library audits do not replace an independent review of this integration.
