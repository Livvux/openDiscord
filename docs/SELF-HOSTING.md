# Self-hosting

The official instance and every self-hosted instance run the same images.

## Requirements

- Linux host with Docker Engine and the Compose plugin; 1 vCPU and 1 GB RAM is enough for small communities
- A domain pointing at the host, ports 80 and 443 free (Caddy obtains TLS certificates automatically)
- PostgreSQL **18** (bundled; the migrations use the built-in `uuidv7()`)
- Optional: an SMTP account for email verification and password reset

## Install

```sh
git clone <repository> opendiscord && cd opendiscord
cp .env.example .env
# set DOMAIN, and generate secrets:
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   BETTER_AUTH_SECRET=$(openssl rand -base64 32)
docker compose up -d --build
```

The one-shot `migrate` service applies database migrations before `web` starts, on every start.

Without SMTP, accounts work without email verification and password-reset links are written to the
`web` log (`docker compose logs web`). Set `SMTP_URL` and `MAIL_FROM` for real email.

Optional integrations (see `.env.example`):

- **Anti-spam on sign-up:** set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` from a Cloudflare
  Turnstile widget whose hostnames include your `DOMAIN`. Every sign-up then needs a token verified
  server-side. With the CLI: `cf turnstile widgets create --body '{"name":"opendiscord","mode":"managed","domains":["chat.example.org"]}'`.
- **Image attachments:** set `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  (any S3-compatible store works). Keep the bucket private: images are only served through the app,
  which checks channel membership. With the `cf` CLI: `cf r2 buckets create --name opendiscord-media`,
  then an account token (`cf accounts tokens create`) with *Workers R2 Storage Bucket Item Write*
  scoped to that bucket. The access key ID is the token ID; the secret is the SHA-256 hex of the token value.

## Security notes

- `web` is not published on a host port; only Caddy is. Keep it that way: rate limiting trusts the
  `X-Forwarded-For` header that Caddy sets. Caddy overwrites it with the one client IP it resolved.
  If you use another reverse proxy, make sure it overwrites (not appends to) `X-Forwarded-For` and
  that `web` is unreachable from outside.
- **Behind Cloudflare (proxied DNS):** set `TRUSTED_PROXIES` to Cloudflare's ranges, otherwise every
  visitor looks like a Cloudflare edge IP and shares one rate limit. Only those peers may supply
  `Cf-Connecting-Ip`; anyone reaching the server directly can't spoof it:
  `TRUSTED_PROXIES="$(curl -s https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6 | tr '\n' ' ')"`.
  Cloudflare changes these ranges rarely; refresh them when it announces changes. `web` reads the same
  variable: it takes the rightmost untrusted `X-Forwarded-For` entry as the client IP.

## Voice channels

Voice is optional and runs on [LiveKit](https://livekit.io) (Apache-2.0), self-hosted next to the app:

1. Set `LIVEKIT_API_KEY` (any name) and `LIVEKIT_API_SECRET` (`openssl rand -base64 32`), and
   `LIVEKIT_URL=wss://<your domain>/livekit`.
2. Open **7881/tcp** and **7882/udp** on the server's firewall (media). Signalling uses the HTTPS port
   through Caddy, so no extra certificate or DNS name is needed.
3. Start with the profile: `docker compose --profile voice up -d`.

The app only hands out room tokens (valid 60 seconds, just long enough to connect; microphone, plus camera and screen only with the *Video* permission; no
data channel) after checking the *Join voice* and *Speak* permissions, and removes people from rooms
when they are kicked, banned, suspended or lose access through roles or channel permissions (checked
again a minute later to catch a token fetched just before the change). LiveKit's server API is not
exposed through Caddy. LiveKit never sees the database. Audio is
relayed by your server (an SFU) and not recorded; it is encrypted in transit (DTLS-SRTP) but not
end-to-end. Without the LiveKit settings, voice channels can't be created and the UI hides the option.
Networks that block UDP fall back to TCP 7881; a TURN server is not bundled.

## Dokploy

Use `docker-compose.dokploy.yml` (Git source, this repository): the same services without Caddy, since
Dokploy's Traefik terminates TLS. Add the domain to service `web`, port 3000, with Let's Encrypt, and
set the variables from `.env.example` in Dokploy's environment tab. Behind Cloudflare, set
`TRUSTED_PROXIES` to Cloudflare's ranges: Traefik forwards Cloudflare's `X-Forwarded-For` (when its
entry points trust Cloudflare) and appends the edge address; without trusted proxies every visitor
would share one rate limit. Create the first administrator from the build stage, which has the scripts:
`docker compose -f docker-compose.dokploy.yml run --rm migrate pnpm --filter web exec tsx scripts/bootstrap-instance-admin.ts you@example.com "Initial instance owner"`.
For voice on Dokploy, run LiveKit with `livekit.yaml` as its own service, route `/livekit` (path
stripped) or a subdomain to its port 7880 in Traefik, open 7881/tcp and 7882/udp, and set
`LIVEKIT_URL` accordingly plus `LIVEKIT_API_URL` to LiveKit's internal address.
- If you put a CDN such as Cloudflare in front, it terminates TLS and can see traffic; tell your users.
- `BETTER_AUTH_SECRET` signs sessions and encrypts TOTP secrets. Rotating it signs everyone out and
  invalidates enrolled authenticator apps (users must set 2FA up again). Rotate it if it leaks.
- Passkeys are bound to `DOMAIN`. Changing the domain invalidates registered passkeys.
- Encrypt the disk that holds the `pgdata` volume and your backups.

## Backup and restore

```sh
scripts/backup.sh                         # → backups/opendiscord-<timestamp>.dump (mode 600)

docker compose stop web
scripts/restore.sh backups/opendiscord-<timestamp>.dump   # asks for confirmation, replaces all data
docker compose up -d                      # migrations bring an older backup up to date
```

Backups are PostgreSQL custom-format dumps of the whole instance (accounts, communities, channels,
messages, roles, invites, bans, audit log). Run `backup.sh` from cron and copy the files off the host.
A restore drill is part of the test plan: the round trip is verified to restore identical row counts.

## Upgrade

```sh
scripts/backup.sh
git pull
docker compose up -d --build
```

Migrations are forward-only. To roll back, restore the backup taken before the upgrade and check out
the previous release.

## Moving one community

Community owners can download an export in *Community settings → Export* and import it on another
instance from *Create a community*. Messages keep their author names and times (marked as imported,
owned by the importer); members, accounts and attachments don't move. To move a whole instance, use the
backup below.

## Moving to another server

Back up on the old host, install on the new host with the same `.env` (same `BETTER_AUTH_SECRET`, or
sessions and TOTP enrolments are lost), restore, then switch DNS.

## Local development

```sh
docker compose -f compose.dev.yaml up -d   # Postgres 18 on 127.0.0.1:5433
# 5433 avoids clashing with a locally installed Postgres on 5432, which is usually older than 18
# and fails the migrations. Change it with DEV_DB_PORT and update DATABASE_URL in apps/web/.env.
```
