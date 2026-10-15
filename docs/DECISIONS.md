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

Rate limiting for messages is a Postgres count over an indexed column; Better Auth's limiter is in
memory per process. **Revisit when** running several replicas: switch Better Auth to database-backed
rate limiting or add Redis.

## D5. Better Auth for authentication

Maintained, TypeScript-native, open source, stores data in our database, and ships 2FA, passkeys and
account deletion as plugins, so no custom cryptography.

## D6. Permission model: bit flags + role hierarchy

Bits keep checks cheap and storable in one integer; strict rank comparison prevents moderators from
acting on peers or escalating themselves. Channel overrides (P1) will add allow/deny bits per channel.

## D7. UI: Tailwind CSS v4 + shadcn/ui (Base UI primitives)

Components are copied into the repo (`components/ui`), so there's no runtime UI framework lock-in.
`shadcn` is a dev dependency only (its CSS is compiled at build time).

## D8. Voice and video: LiveKit (planned, P1)

**Options considered:** LiveKit (Apache-2.0 SFU, Go, built-in TURN, client SDKs, E2EE support),
mediasoup (library; we would build signalling and ops ourselves), Jitsi (complete but heavier and
meeting-oriented). **Choice:** LiveKit as an optional compose profile. The web app issues short-lived
room tokens after checking channel permissions, so LiveKit never needs our database.

## D9. Attachments (planned, P1)

Local volume by default, any S3-compatible store optional (MinIO, Garage, Cloudflare R2, AWS S3) to
avoid lock-in. Images re-encoded with `sharp` to strip metadata; optional ClamAV sidecar.

## D10. End-to-end encryption (planned, P1)

No custom cryptography. DMs and small groups will use an audited implementation of MLS (RFC 9420) or
the Signal protocol, chosen by audit status and maintenance at implementation time. Large community
channels stay server-readable (moderation, search, new-member history), which is documented, not hidden.

## D11. Cloudflare is optional

Nothing depends on Cloudflare. Operators may put it in front as CDN/DDoS protection, but it
terminates TLS and therefore sees traffic; the official instance must disclose this if it does so.

## D12. Not-found responses inside streamed pages

With Cache Components, pages stream; a `notFound()` after the shell is sent renders the 404 UI with a
200 status. Access control does not depend on the status code: no data is rendered, and APIs return
real 401/403/404 statuses.
