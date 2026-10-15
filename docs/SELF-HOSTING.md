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

### Optional TURN over TLS on a shared Traefik listener

For restrictive networks, LiveKit's embedded TURN service can share Traefik's existing 443/TCP
listener through a dedicated hostname. Create a DNS-only A record for that hostname; ordinary
Cloudflare HTTP proxying does not carry TURN. Add the following to the actual LiveKit configuration:

```yaml
turn:
  enabled: true
  domain: turn.example.com
  tls_port: 5349
  external_tls: true
```

Add a separate Traefik dynamic file, substituting the hostname, internal service name, existing
entry point and certificate resolver:

```yaml
tcp:
  routers:
    community-turn:
      rule: HostSNI(`turn.example.com`)
      entryPoints: [websecure]
      service: community-turn
      tls:
        certResolver: letsencrypt
        domains: [{main: turn.example.com}]
  services:
    community-turn:
      loadBalancer:
        servers: [{address: livekit:5349}]
```

Traefik terminates TLS and forwards plaintext TURN across the private service network. Keep 5349
private; do not enable TLS passthrough with this configuration. LiveKit 1.13 advertises public 443
when `external_tls` is enabled. Its signaled credentials authenticate participants; never ship the
LiveKit API secret or a static TURN password to browsers. Preserve existing relay peer restrictions.

On Dokploy, change the persisted service source as well as its generated runtime file so a later
deployment retains TURN. Save a private backup first, preserve unrelated SNI routes, and restart
only the voice service when no participants are present. Verify certificate trust, app readiness,
other shared hostnames and actual audio/video with `iceTransportPolicy: "relay"`; a TLS handshake
alone does not establish media connectivity. TURN provides transport and does not add E2EE.

The official instance uses `turn.opendiscord.app` and media ports 7891/TCP and 7892/UDP because
another service owns the default 7881/7882. These are instance-specific overrides, not new defaults.

## Push notifications

Optional. Generate VAPID keys once (`npx web-push generate-vapid-keys`) and set `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:` or `https:` contact). People then switch on push for
mentions per device in their account settings. Browsers deliver pushes through their vendor's push
service; the payload (sender, channel, start of the message) is end-to-end encrypted for the device.
The server only contacts well-known push services.

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
- Keep `BETTER_AUTH_SECRET` stable for legacy encrypted records and HMAC rate-limit keys.
  Better Auth 1.7.7 also supports optional `BETTER_AUTH_SECRETS`, comma-separated `version:secret`
  entries, newest first (for example `2:<new-random-secret>,1:<previous-random-secret>`). Each secret
  must contain 32–256 non-whitespace characters; use independently generated random values.
  Both Compose stacks forward this setting. With it, new encrypted auth records use the first key;
  retained keys decrypt previous versioned records, and `BETTER_AUTH_SECRET` decrypts legacy records.
- Before rotation, make and verify an encrypted backup that also protects every required auth key.
  Add the new key first while retaining all previous versions and the legacy secret. Deploy identical
  configuration to all replicas together. Expect signed session cookies and outstanding auth links to
  become invalid when the primary key changes: users may need to sign in again. Retained encryption
  keys preserve TOTP/backup-code decryption; this is not a guarantee that all auth tokens survive.
- Do not retire a key while any stored auth ciphertext or retained backup still needs it. This release
  does not bulk re-encrypt old rows. For rollback retain both keys and put the old primary first;
  removing the new key would strand records created during the rollout. A compromised-key incident
  requires revocation and a recovery/re-enrolment plan; simply retaining the leaked key is not remediation.
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
owned by the importer); members and accounts don't move. The JSON export excludes files. Choose
*Download archive with files* for a gzip archive containing the newest 100,000 messages and their
files (at most 4,096 files and 256 MiB of file data). Exceeding a limit or encountering a missing file
fails the archive instead of silently omitting files. Concurrent edits can change an export; it is
not a transactional snapshot. Gzip compresses the archive but does not encrypt it. Store it privately.

Imports revalidate files through the normal upload processing and optional scanner. Failed imports
can leave private, unlinked files eligible for cleanup after one hour; they remain charged against
the upload quota until cleanup. If confirmation fails, check the community list before retrying.
To move a whole instance, use the backup below.

## Moving to another server

Back up on the old host, install on the new host with the same `.env` (same `BETTER_AUTH_SECRET` and all retained
`BETTER_AUTH_SECRETS` versions, or sessions and encrypted TOTP enrolments may become inaccessible), restore, then switch DNS.

## Local development

```sh
docker compose -f compose.dev.yaml up -d   # Postgres 18 on 127.0.0.1:5433
# 5433 avoids clashing with a locally installed Postgres on 5432, which is usually older than 18
# and fails the migrations. Change it with DEV_DB_PORT and update DATABASE_URL in apps/web/.env.
```

## Retention maintenance

Schedule maintenance hourly from the same release and environment as the app. First inspect the dry run:

```sh
docker compose run --rm --no-deps migrate pnpm --filter web exec tsx scripts/maintenance.ts
# Apply the documented retention policy (180-day audit/resolved-report retention):
docker compose run --rm --no-deps migrate pnpm --filter web exec tsx scripts/maintenance.ts --apply
```

On Dokploy add `-f docker-compose.dokploy.yml` and use the deployed checkout/environment. Never build
a new migration image on a running production host just to execute maintenance; use its already-built
`migrate` image (`--no-build`). Serialize scheduled runs with `flock`, retain job failure logs without
credentials and alert on failure. The command prints aggregate counts only, is a dry run by default,
and processes bounded batches. Inspect `limited` to detect a backlog. The command does not delete
accounts, messages or open reports. Back up before initially applying the retention policy.


### Private local attachments and optional scanning

Use either the existing S3-compatible `R2_*` settings or an absolute `ATTACHMENT_DIR`, never both.
Local attachments remain accessible only through the authenticated, permission-checked attachment
route; never place this directory inside a web root or expose its volume through a proxy. Give the
application user a writable private directory and include that volume in encrypted backups/restores.
For the standard non-root Docker image, mount a directory owned by the image’s application user and pass
`ATTACHMENT_DIR=/data/attachments` using a Compose override with a persistent volume at `/data`.
All replicas must see the same storage; local storage on independent replica disks is unsupported.
Switching backends does not migrate existing files: copy and verify their `attachments/` keys first.
The hosted instance continues to use its existing private R2 bucket.

Optionally set `CLAMAV_HOST` and `CLAMAV_PORT` (default 3310) to a maintained clamd on the private
service network. The app sends each original upload using clamd's INSTREAM protocol before storage.
Set clamd `StreamMaxLength` at least as high as the configured 25 MB file limit and keep signatures
updated. The service must support the upload's processing budget: the app uses a 20-second total
scan deadline, caps replies at 4 KiB, and rejects infected files, unavailable scanners, protocol errors
and timeouts. With no host configured, scanning is disabled. Do not publish clamd's unauthenticated
TCP port. Malware scanning reduces risk; it cannot guarantee a file is harmless. Image re-encoding,
private storage, permission checks and forced file downloads remain in effect with either backend.


### Registration and public operator policies

The default minimum age is 16, as selected for the official instance. Set `MINIMUM_AGE` (13–99)
to your own documented policy and obtain legal advice appropriate to your operation. Signup requires
an explicit current-policy self-attestation in the UI and server endpoint contract; no birth
date, identity document or age-verification claim is stored. This is a self-attestation, not proof of age.
API clients creating human accounts must pass `x-opendiscord-registration` with the value generated
by `registrationAttestation(minimumAge)` in `src/lib/registration-policy.ts`. Existing users are not
silently re-attested when the policy changes.

For public legal pages set all of `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_COUNTRY`, and
`OPERATOR_EMAIL`. The official operator defaults apply only when the configured public origin is
exactly opendiscord.app. Other domains never inherit lk media's identity. Review the notice for your
actual infrastructure, purposes, jurisdiction and retention. Technical policies and generated pages
do not constitute a professional legal assessment or establish regulatory compliance.
