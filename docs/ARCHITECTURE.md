# Architecture

openDiscord is one Next.js application backed by one PostgreSQL database. There are no other services
in the MVP. Each choice is explained in [DECISIONS.md](DECISIONS.md).

```
 browser ──HTTPS──▶ Caddy (TLS, HSTS, compression) ──▶ web (Next.js, Node 22) ──▶ PostgreSQL 18
                                                         │  ▲
                                                         │  └─ LISTEN opendiscord_events (one connection per process)
                                                         └──── NOTIFY on every write that others must see
```

## Code layout (`apps/web/src`)

| Path | Role |
| --- | --- |
| `db/auth-schema.ts` | Better Auth tables (generated, do not edit) |
| `db/app-schema.ts` | Communities, roles, members, channels, messages, invites, bans, audit log |
| `server/permissions.ts` | Pure permission model: bit flags, hierarchy, escalation rules (unit-tested) |
| `server/access.ts` | The single gate: loads a member's authority or answers "not found" |
| `server/communities.ts`, `moderation.ts`, `messages.ts`, `account.ts` | Domain services. Every function takes the acting user id, validates input with zod and authorises before touching data |
| `server/realtime.ts` | LISTEN/NOTIFY hub and event schema |
| `app/app/actions.ts` | Server Actions: authenticate, call a service, refresh the router |
| `app/api/**` | Route handlers: SSE stream, message pages, data export, Better Auth |
| `components/app/**` | Chat UI (client components where interaction needs it) |
| `lib/auth.ts` | Better Auth configuration (password, reset, 2FA, passkeys, deletion, privacy hooks) |

Rules that keep this safe and small:

- Pages, actions and route handlers never query community data directly; they call `server/*`.
- Services receive raw input (`unknown`) and parse it themselves, so no caller can skip validation.
- Non-members get "not found", never "forbidden", so ids do not reveal what exists.

## Data model

All community ids are UUIDv7 (Postgres 18 `uuidv7()`), so ids sort by creation time and serve as
pagination cursors. User ids come from Better Auth.

- `community` (owner restricts user deletion) → `role` (bit-set permissions, position, one default role)
- `member` (community, user) → `member_role`; removing a member removes its role assignments
- `channel` → `message` (author cascade: deleting an account deletes its messages), `channel_override` (role allow/deny bits)
- `invite` (random 96-bit code, optional expiry and use limit), `ban`, `audit_log` (no message content)

## Permissions

Effective permissions are the union of the default role and the member's roles; `Administrator`
expands to all. The owner has all permissions and the highest rank. A member's rank is their highest
role position. Moderation (kick, ban, assigning roles) requires the actor to rank strictly above the
target. Roles can only be created, edited or assigned below the actor's rank and only with
permissions the actor holds. New roles from non-owners are inserted directly below the creator.
All checks run on the server inside a transaction that locks the community row.

Channels can override the view, send and delete-others'-messages bits per role (`channel_override`):
the default role's override applies first, then the union of the member's other roles (allow beats
deny). Owners and administrators bypass overrides. `requireChannel` is the single gate for channel
access; a channel the member cannot view is "not found" everywhere (lists, message APIs, uploads,
reports and the realtime stream). Editing overrides needs Manage channels and Manage roles and follows
the same escalation rule as editing the role itself.

## Realtime

1. A write commits, then the service calls `pg_notify('opendiscord_events', {type, ids})`.
   Payloads carry ids only (NOTIFY is limited to 8 kB and must not carry private content).
2. Each web process keeps one `LISTEN` connection and fans events out to its subscribers.
3. `GET /api/communities/:id/events` is an SSE stream (max. 8 per user and process). It checks
   membership on connect, closes when the subscriber is removed, re-checks membership after every
   LISTEN reconnect (when removal events could have been missed) and ends after 10 minutes so access
   is re-checked on reconnect. Each message is loaded once per event and process, not per subscriber.
4. The client merges events by id. The server sends a `ping` event every 25 s; after 60 s of silence,
   or when the browser comes back online, the client reconnects. After every reconnect it refetches
   the newest page: the page is authoritative for its range (offline deletions disappear), and if more
   than a page was missed, older local history is dropped rather than leaving a hidden gap.

Personal events (mentions) go to a second stream per tab, `GET /api/me/events`, on the topic
`user:<id>`. It re-checks that the person can still read the channel before delivering a mention and
carries only what a notification needs (sender, channel, a 140-character excerpt). Unread state is a
`channel_read_state` row per person and channel (the last read UUIDv7 id, only ever moved forward);
mentions are `<@userId>` tokens in the content, indexed in `mention` for counts. Counts are computed
only over channels the person can view.

This works across several web replicas without Redis because Postgres delivers each NOTIFY to every
listener. Delivery is at-most-once; the resync on reconnect is the recovery path.

## Authentication

Better Auth with email + password (min. 10 characters), optional email verification and password reset
when SMTP is configured, TOTP two-factor (secrets encrypted with `BETTER_AUTH_SECRET`), passkeys
(WebAuthn, bound to the `BETTER_AUTH_URL` origin), and account deletion. Session rows do not store IP
addresses. Server Actions are protected against CSRF by Next.js origin checks; Better Auth checks
origins on its own endpoints.

## Deployment

`docker-compose.yml`: `db` (Postgres 18, not exposed), `migrate` (one-shot Drizzle migrations),
`web` (standalone Next.js, non-root), `caddy` (automatic HTTPS, HSTS, unbuffered proxying for SSE).
The official instance runs the same images. See [SELF-HOSTING.md](SELF-HOSTING.md).

## Testing

- `tests/*.test.ts` (Vitest): permission model, services against a real Postgres (authorisation,
  escalation, invites, bans, rate limit, pagination, export, deletion, realtime fan-out, 2FA at rest).
- `e2e/*.spec.ts` (Playwright, production build): onboarding, invites, two-user realtime chat,
  moderation, editing, keyboard use, XSS rendering, export, deletion, TOTP, passkeys, mobile
  navigation, and axe WCAG checks.
