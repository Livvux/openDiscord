# Contributing

Thanks for helping. openDiscord aims to stay small, private by default and easy to self-host, so
every change should justify its complexity.

## Before you start

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).
- For anything larger than a bug fix, open an issue first to agree on the approach.
- Security problems: see [SECURITY.md](SECURITY.md), not the issue tracker.

## Development

See the README for setup. Before opening a pull request:

```sh
pnpm lint && pnpm typecheck && pnpm test
pnpm build && pnpm test:e2e
```

## Rules of the codebase

- Community data is only read or written through `apps/web/src/server/*` services, which validate
  input and check permissions. Add a test for every new permission rule.
- No third-party scripts, trackers or external requests from the browser.
- No custom cryptography.
- New dependencies need a reason in the PR description (maintenance, license, size).
- User-facing claims about privacy or security must be backed by code and tests.

## Commits and licensing

Use conventional commit messages (`feat:`, `fix:`, `docs:` …). By contributing you agree that your
contribution is licensed under AGPL-3.0-only.
