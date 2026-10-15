# Technical decisions

Short records of choices that are expensive to reverse. Newest last.

## D1. One Next.js app, no microservices

**Decision:** UI, API and realtime run in one Next.js process type.
**Why:** a self-hoster should run four containers, not twelve. Scaling out means more replicas of the
same image. **Revisit when:** a component needs a different runtime (voice SFU) or scaling profile.

## D2. PostgreSQL 18 as the only datastore

**Decision:** Postgres holds everything; Postgres 18 is required (built-in `uuidv7()`).
**Why:** boring, well understood, backups with `pg_dump`. UUIDv7 gives time-ordered ids for cursor
pagination without a sequence per table. **Note:** older Postgres versions fail the first migration.

## D3. Realtime: Server-Sent Events + LISTEN/NOTIFY, no Redis, no WebSocket server

**Decision:** server→client events over SSE; client→server writes over Server Actions; cross-process
fan-out via Postgres NOTIFY.
**Why:** chat traffic is mostly server→client. SSE works through Caddy and corporate proxies, reconnects
natively, needs no custom server, and NOTIFY already reaches every replica.
**Trade-offs:** one LISTEN connection per process plus one HTTP connection per open community per client;
at-most-once delivery (clients resync on reconnect). **Revisit when:** typing indicators/presence need
client→server streaming at volume, or connection counts exceed what Node handles per replica. Then
Redis pub/sub or NATS is the next step.

## D4. Redis is not used

Rate limiting for messages is a Postgres count over an indexed column. Better Auth's per-IP limits use
a Postgres table too (`auth_rate_limit`, one atomic upsert per request), so they hold across replicas.
Its keys are HMACs of "IP + path" with the server secret, so no IP address is stored; rows older than a
day are purged. Better Auth's own database storage was not used because it stores the raw IP.
Application mutation, read, upload and integration limits use atomic sliding windows in
`application_rate_limit`. SSE slots use transaction-serialized `stream_lease` rows: eight personal
and eight community streams per user across all replicas. Disconnects release leases; a dead worker
loses its slots after ten minutes plus a thirty-second cleanup allowance. No extra service is needed.

## D5. Better Auth for authentication

Maintained, TypeScript-native, open source, stores data in our database, and ships 2FA, passkeys and
account deletion as plugins, so no custom cryptography.

## D6. Permission model: bit flags + role hierarchy

Bits keep checks cheap and storable in one integer; strict rank comparison prevents moderators from
acting on peers or escalating themselves. Channel overrides (P1) will add allow/deny bits per channel.

## D7. UI: Tailwind CSS v4 + shadcn/ui (Base UI primitives)

Components are copied into the repo (`components/ui`), so there's no runtime UI framework lock-in.
`shadcn` is a dev dependency only (its CSS is compiled at build time).

## D8. Voice and video: LiveKit (voice shipped)

**Options considered:** LiveKit (Apache-2.0 SFU, Go, built-in TURN, client SDKs, E2EE support),
mediasoup (library; we would build signalling and ops ourselves), Jitsi (complete but heavier and
meeting-oriented). **Choice:** LiveKit as an optional compose profile. The web app issues short-lived
room tokens after checking channel permissions, so LiveKit never needs our database. When access
changes (kick, ban, suspension, roles, channel overrides) the app lists each voice room's participants
and removes or mutes those who lost access, best effort. Signalling is proxied at `/livekit` on the
app's domain; the Content-Security-Policy is set per request (`src/proxy.ts`) so it can name the
operator's LiveKit server, which a build-time header config can't know.

## D9. Attachments (images and files shipped; local volume planned)

Any S3-compatible store (Cloudflare R2 by default, MinIO, Garage, AWS S3), signed with SigV4 via
`aws4fetch` instead of the much larger AWS SDK. Images only (PNG, JPEG, WebP, GIF, max 8 MB, 4 per
message), decoded and re-encoded to WebP with `sharp`, which drops EXIF/GPS and rejects anything that
isn't a real raster image. Objects are private and served through `/api/attachments/:id`, which
checks channel membership on every request. Deleted messages unlink their images immediately; a sweeper
removes unlinked objects after an hour. Other files (max 25 MB) are stored byte-for-byte and served only
as downloads with a generic content type, so they can't execute on the app origin; the original name is
cleaned and shown as text. Local-volume storage and a ClamAV sidecar remain open.

## D10. End-to-end encrypted direct messages

One-to-one DMs use the maintained Matrix Rust crypto state machine through pinned
`@matrix-org/matrix-sdk-crypto-wasm` 18.9.0 (matrix-sdk-crypto 0.19.1, vodozemac 0.11.0).
Olm distributes device keys; Megolm encrypts conversation events. We implement the bounded Matrix
transport shapes over authenticated application accounts, not federation or a Matrix homeserver.
The SDK performs signature validation, SAS verification, ratcheting and message encryption.
Every active sending/receiving device must be verified; unknown devices fail closed.

This supersedes the earlier MLS/Signal preference. Upstream OpenMLS browser bindings remain
experimental; its audited core does not make an unaudited browser/storage integration audited.
The maintained Matrix browser package exposes persistent IndexedDB, real SAS, cross-signing and
key export/import in one state machine. The vodozemac audit covers that cryptographic library,
not this application, its web delivery, transport or recovery composition. No independent audit of
openDiscord is claimed. See [private messaging architecture and limitations](PRIVATE-MESSAGES.md).

The server stores ciphertext, public keys and delivery metadata. Encrypted backups contain identity
secrets and explicitly labelled, source-authenticated read-only history copies; the private recovery file containing the encryption key remains with
the user. Matrix attachment encryption is reused rather than inventing an encryption format. Community
channels remain server-readable for moderation, search and history. Voice encryption is a separate
integration and is not implied by encrypted DMs.

## D11. Cloudflare is optional

Nothing depends on Cloudflare. Operators may put it in front as CDN/DDoS protection, but it
terminates TLS and therefore sees traffic; the official instance must disclose this if it does so.

## D12. Not-found responses inside streamed pages

With Cache Components, pages stream; a `notFound()` after the shell is sent renders the 404 UI with a
200 status. Access control does not depend on the status code: no data is rendered, and APIs return
real 401/403/404 statuses.
