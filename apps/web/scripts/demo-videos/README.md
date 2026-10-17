# Demo videos

Re-creates the screen recordings in `public/media/demo/` (`chat`, `threads`, `moderation`, `invite`; each `.mp4` plus a `.jpg` poster).
They are real captures of the running app, not mock-ups.

## How it works

`run.mts` seeds fresh fictional people (Mara, jonas, Ife, Kai, Toby) and a "Study Hall" community per take, then records one
person's screen with Playwright's screencast (JPEG frames, encoded to H.264 with ffmpeg: 1440x900, 30 fps, no audio).
Other people act from their own browser contexts, so messages arrive live over the real SSE stream.

`proxy.mts` fronts the local build with TLS and the browser maps `opendiscord.app` to it, so invite links read
`https://opendiscord.app/invite/…` (`.app` is HSTS-preloaded, hence https).

## Run

```sh
# 1. Postgres 18 (needs uuidv7()) and migrations
docker run -d --name od-demo-pg -p 5433:5432 -e POSTGRES_USER=opendiscord -e POSTGRES_PASSWORD=opendiscord -e POSTGRES_DB=opendiscord_demo postgres:18-alpine
DATABASE_URL=postgres://opendiscord:opendiscord@localhost:5433/opendiscord_demo pnpm --filter web db:migrate

# 2. Production build, standalone server on :3300 as https://opendiscord.app
#    (Turnstile test keys, no R2/SMTP; do not use a real .env)
pnpm --filter web build
cp -r .next/static .next/standalone/apps/web/.next/ && cp -r public .next/standalone/apps/web/
PORT=3300 HOSTNAME=127.0.0.1 BETTER_AUTH_URL=https://opendiscord.app BETTER_AUTH_SECRET=<any 32+ chars> \
  DATABASE_URL=postgres://opendiscord:opendiscord@localhost:5433/opendiscord_demo \
  TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
  node .next/standalone/apps/web/server.js

# 3. Record (all takes, or name some); output goes to ~/.cache/od-demo/out (override with DEMO_OUT)
pnpm --filter web exec tsx scripts/demo-videos/run.mts [chat|threads|moderation|invite]
```

Then copy the `.mp4`/`.jpg` files into `public/media/demo/`. Keep each file under ~1.5 MB.

## Notes

- Check for a stale `next-server` on :3300 first; an old one keeps the wrong `BETTER_AUTH_URL` and sign-ups fail with "Invalid origin".
- The ban reason is a native `window.prompt`, which video can't show. The moderation take bans Toby off camera and records
  the role change, the ban list and the audit log.
- Voice/LiveKit and DMs are not recorded: voice needs WebRTC infrastructure, and DMs need device verification (SAS) first.
- Run `tsc --noEmit` and `eslint scripts/demo-videos` after edits; the folder is part of the web app's type-check.
