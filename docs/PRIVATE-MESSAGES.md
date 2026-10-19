# Private messages

Direct conversations require a request and acceptance. Start a request from a community member's
message; there is no global account directory. Blocking either participant stops new messages and
cross-account encryption traffic. Existing local history is not erased by blocking.

## Groups

A group has 3–10 people. Its creator picks two to nine of their friends; any member can add more of
their own friends (never someone they blocked or who blocked them) and rename the group; the owner
(the creator, or after they leave the longest-standing member) can remove people; anyone can leave.
The last person leaving deletes the group and all of its ciphertext, as does deleting that person's
account. Deleting the creator's account keeps the group for the others.

Each group is one Megolm conversation. Before every send the browser fetches the current member list,
queries every member's devices and applies the same trust rules as in 1:1 conversations; any change of
people or devices (join, leave, removal, a new or revoked device) rotates the outbound session, so
someone who left or was removed receives no key for later messages. The server enforces membership at
the same time: a former member can no longer list messages or exchange device keys with the group.
Someone added later receives keys only for later messages, and the server lists only messages from
after they joined. Former members' earlier messages stay readable and are attributed to them; the
remaining members may still look up a former member's public device keys for that, never deliver keys
to them. A message whose send began just before a removal committed can still be encrypted to the
removed person's devices; the server then refuses them the ciphertext, but a dishonest server could
hand it over. Removal is not a ban: any member who is friends with a removed person can add them
again, and they then receive keys for messages from that point.

A member who has not set up encryption yet gets no keys and cannot read messages sent before they do;
sending is not blocked for the others. Two members where one blocked the other exchange no keys and
cannot read each other's new messages; a changed identity of any member stops sending until verified.

The server manages membership, so it can add a person or device to a group just as it can substitute
keys before first contact (see below). New members are shown in the member list; verify devices with
SAS to rule this out. The group name and member list are **plaintext metadata**: the server stores
the name and sees who is in which group, who joined, left or was removed, and when. Unread markers,
live updates and push notifications use the same content-free events as 1:1 conversations, and a
group push names only the sender.

## Trust and delivery

The browser runs `@matrix-org/matrix-sdk-crypto-wasm` **18.9.0**, whose reported native versions are
matrix-sdk-crypto **0.19.1** and vodozemac **0.11.0**. Olm protects device-to-device key delivery;
Megolm protects conversation events. Public account cross-signing and device keys are stored on the
application server. Device credentials authenticate uploads and mailbox access but are **not** the
E2EE keys; knowing a server API credential cannot decrypt message ciphertext.

Friends open a conversation directly; other people get a message request first. Each browser sets up
its encryption device on the first visit to Home, so it can receive messages before opening them.
Contacts are **trusted on first use**: the SDK pins a peer's cross-signing identity when it first sees
it, and a peer device is accepted when that identity signed it (identity-based key sharing, lax shield).
If the pinned identity changes, sending and reading stop until the contact is verified again. This
protects against a later swap of keys, not against a server that substitutes keys before first contact.
To rule that out, compare all three SAS numbers over a separate authenticated channel in **Devices and
recovery**; clicking the confirmation means the numbers matched on both devices. There is no plaintext
fallback. Unsigned devices, and unverified devices on your own account, never receive keys. Revocation removes public device availability, prekeys and pending mailbox data.
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

## Encrypted attachments

Images and files are encrypted in the sender's browser with the SDK's Matrix attachment format
(`Attachment.encrypt`: AES-256-CTR with a fresh random key and IV, plus a SHA-256 hash of the
ciphertext), the same primitive the recovery backups use. Only ciphertext is uploaded, to the instance's
existing private object storage. The key, IV, hash, original file name, MIME type and size travel inside
the Megolm-encrypted message, so they are protected like message text. The server stores an opaque
object with a random ID, uploader and ciphertext size (equal to the file size: AES-CTR adds no padding),
and learns which message links which object IDs. It never receives a plaintext byte, name or type.

The upload endpoint accepts at most 25 MB per file (the community file limit) from a member who may post
to the conversation, at most four files per message, and shares the per-account upload rate, pending
upload and daily byte quotas with community uploads. An upload becomes readable only after an encrypted
message links it, and only to that conversation's participants; it is served as `application/octet-stream`
download with `nosniff` and a sandbox CSP. The receiving browser downloads the ciphertext, requires its
length to match the authenticated payload, verifies the hash and decrypts with the SDK; any mismatch shows
an error and no content. Images in PNG, JPEG, WebP or GIF are displayed inline from a local object URL
that is revoked when the message leaves the screen; every other type, including SVG, is only offered as a
download. Decrypted bytes are not re-encoded: image metadata such as EXIF/GPS that the sender's file
contains reaches the recipient unchanged.

**Malware scanning cannot apply.** The optional ClamAV scanner (`CLAMAV_HOST`) inspects community
uploads, but the server never has the key to DM attachments, so it cannot scan, re-encode or
content-filter them. Recipients should treat files from others with the usual care.

Deleting a conversation, including through either participant's account deletion, deletes its
messages and unlinks their attachments; the media sweeper then removes the stored ciphertext. Unsent
uploads are removed after an hour. Account export lists the encrypted attachment references (ID,
message, ciphertext size, download path) for the caller's conversations; the keys remain inside the
exported message ciphertext. Recovery backups and device transfers carry the attachment keys inside
the archived message, not the files; an archive copy shows the text only, and the file stays
retrievable only while its conversation exists on the server.

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
It also stores, per person and conversation, the newest message ID they have seen (read marker) to
count unread messages; the peer never receives it. New-message events and Web Push notifications
carry only the sender and conversation, never text: the server has no key to read it, and a push
says "New encrypted message" with the sender's display name.
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
messages, ciphertext backups and the caller's reports; version 11 adds the caller's read markers; version 12 adds encrypted attachment references. It never includes device bearer secrets or
browser private keys. Account deletion cascades device keys, mailbox contents, backups, conversation
ciphertext and related reports. Previously downloaded plaintext, private recovery files and other
participants' local browser copies cannot be remotely erased.

## Operational limits and evidence

Limits: ten active devices, 500 conversations (1:1 conversations plus current group memberships)
within the account's checked conversation cap, groups of 3–10 people with 100-character names, 4,000-character messages, 24,000-character message ciphertext, four encrypted attachments of up to 25 MB each per message, 256 pending events per device (large encrypted own-device transfers require fewer than 16 pending
events),
8 KB per peer device event, 100 device deliveries per crypto operation (a full group of ten people with ten devices each), 100 available one-time prekeys and 100,000 lifetime prekey
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

Automated coverage is maintained in `tests/dm-crypto.test.ts`, `tests/dm-attachments.test.ts`,
`tests/dm-attachments.integration.test.ts`, `e2e/dm-attachments.spec.ts`, `tests/dm-groups.integration.test.ts`, `e2e/dm-groups.spec.ts`, `tests/dm-matrix.integration.test.ts`,
`tests/direct-messages.integration.test.ts`, `tests/dm-reset.integration.test.ts` and
`e2e/direct-messages.spec.ts`; passing results must be checked on the exact release commit. Tests and
upstream library audits do not replace an independent review of this integration.
