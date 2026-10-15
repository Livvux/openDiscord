<img src="assets/icon.svg" width="64" height="64" alt="">

# opendiscord

Open-source community chat you can host yourself. The official instance runs at
[opendiscord.app](https://opendiscord.app); every self-hosted install runs the same release
and works without it.

> Status: early development (Phase 1 – foundation). Not end-to-end encrypted.

## Stack

Next.js (App Router) · PostgreSQL + Drizzle · Better Auth · Tailwind CSS · Docker Compose + Caddy

## Self-host

```sh
cp .env.example .env   # set DOMAIN, POSTGRES_PASSWORD, BETTER_AUTH_SECRET
docker compose up -d --build
```

Point your domain's DNS at the server; Caddy obtains TLS certificates automatically.
Migrations run on every start via the one-shot `migrate` service.

## Develop

```sh
docker compose -f compose.dev.yaml up -d      # Postgres on 127.0.0.1:5432
cp apps/web/.env.example apps/web/.env
pnpm install
pnpm db:migrate
pnpm dev                                      # http://localhost:3000
```

| Command | Purpose |
| --- | --- |
| `pnpm test` | Vitest (integration tests need the dev database) |
| `pnpm typecheck` / `pnpm lint` | Static checks |
| `pnpm db:generate` | Create a migration after editing `apps/web/src/db/schema.ts` |
| `pnpm --filter web auth:schema` | Regenerate Better Auth tables after changing auth plugins |

## License

[AGPL-3.0](LICENSE). If you run a modified version as a network service, you must offer its
source to your users.
