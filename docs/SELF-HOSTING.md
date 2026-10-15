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

## Security notes

- `web` is not published on a host port; only Caddy is. Keep it that way: rate limiting trusts the
  `X-Forwarded-For` header that Caddy sets. If you use another reverse proxy, make sure it overwrites
  (not appends to) `X-Forwarded-For` and that `web` is unreachable from outside.
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

## Moving to another server

Back up on the old host, install on the new host with the same `.env` (same `BETTER_AUTH_SECRET`, or
sessions and TOTP enrolments are lost), restore, then switch DNS.

## Local development

```sh
docker compose -f compose.dev.yaml up -d   # Postgres 18 on 127.0.0.1:5433
# 5433 avoids clashing with a locally installed Postgres on 5432, which is usually older than 18
# and fails the migrations. Change it with DEV_DB_PORT and update DATABASE_URL in apps/web/.env.
```
