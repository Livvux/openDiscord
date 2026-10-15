<img src="assets/icon.svg" width="64" height="64" alt="">

# openDiscord

Open-source community platform you can host yourself. *Communities belong to everyone.* The official instance runs at
[opendiscord.app](https://opendiscord.app); every self-hosted install runs the same release
and works without it.

> **Status: early development — text-chat MVP.** Communities, channels, roles, invites, moderation,
> realtime messaging, data export and account deletion, 2FA and passkeys work and are tested.
> Voice, DMs, attachments and search are not built yet ([roadmap](docs/ROADMAP.md)).
> **Nothing is end-to-end encrypted yet**: the operator of an instance can read community messages
> ([privacy](docs/PRIVACY.md)). No external security audit has been done.
> Name and marks are pending a trademark review, see [docs/brand](docs/brand/BRAND-GUIDELINES.md).

## Stack

Next.js (App Router) · PostgreSQL 18 + Drizzle · Better Auth · Tailwind CSS + shadcn/ui ·
Server-Sent Events over Postgres LISTEN/NOTIFY · Docker Compose + Caddy

## Self-host

```sh
cp .env.example .env   # set DOMAIN, POSTGRES_PASSWORD, BETTER_AUTH_SECRET
docker compose up -d --build
```

Point your domain's DNS at the server; Caddy obtains TLS certificates automatically.
Ports 80 and 443 must be free on the host. Migrations run on every start via the one-shot `migrate` service.
Backups, upgrades and security notes: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## Develop

```sh
docker compose -f compose.dev.yaml up -d      # Postgres 18 on 127.0.0.1:5433 (DEV_DB_PORT to change)
cp apps/web/.env.example apps/web/.env
pnpm install
pnpm db:migrate
pnpm dev                                      # http://localhost:3000
```

| Command | Purpose |
| --- | --- |
| `pnpm test` | Vitest unit and integration tests (need the dev database) |
| `pnpm build && pnpm test:e2e` | Playwright against the production build (desktop + mobile, axe a11y checks) |
| `pnpm typecheck` / `pnpm lint` | Static checks |
| `pnpm db:generate` | Create a migration after editing `apps/web/src/db/app-schema.ts` |
| `pnpm --filter web auth:schema` | Regenerate Better Auth tables after changing auth plugins |

## Documentation

[Instance administration](docs/INSTANCE-ADMINISTRATION.md) · [API](docs/API.md) · [Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/DECISIONS.md) · [Threat model](docs/THREAT-MODEL.md) ·
[Privacy](docs/PRIVACY.md) · [Roadmap and gap analysis](docs/ROADMAP.md) · [Self-hosting](docs/SELF-HOSTING.md) ·
[Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## License

[AGPL-3.0](LICENSE). If you run a modified version as a network service, you must offer its
source to your users.
