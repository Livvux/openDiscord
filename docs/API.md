# Public API (v1)

For bots and incoming webhooks created in *Community settings → Bots and webhooks* (needs *Manage
community*). The machine-readable description is served at `/api/v1/openapi.json` (OpenAPI 3.1).

## Bots

A bot is a member of one community with its own account. It joins with the default role; give it roles
like anyone else. Every call runs through the same permission checks as the app, so a bot can only read
and send where its roles allow, and hidden channels answer `404`.

```sh
curl -H "Authorization: Bot $TOKEN" https://example.org/api/v1/me
curl -H "Authorization: Bot $TOKEN" https://example.org/api/v1/communities/$COMMUNITY/channels
curl -H "Authorization: Bot $TOKEN" "https://example.org/api/v1/channels/$CHANNEL/messages?before=$MESSAGE"
curl -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"Hello from a bot"}' https://example.org/api/v1/channels/$CHANNEL/messages
```

Limits: 60 requests per minute per bot, plus the normal message rate limit and AutoMod. Mentions from
bots notify like any member's.

## Incoming webhooks

A webhook posts plain messages into one text channel and holds no other rights:

```sh
curl -H "Content-Type: application/json" -d '{"content":"Build #42 passed"}' \
  https://example.org/api/webhooks/$ID/$TOKEN
```

Mentions are turned into plain names: webhooks can't ping or badge anyone. AutoMod always applies. Unknown, revoked and mismatched URLs all
answer `404`.

## Tokens

Tokens are shown once and stored only as SHA-256 hashes. Revoking a bot or webhook stops its token at
once (a bot also leaves the community); past messages stay and keep their *BOT* label. There are no
outgoing webhooks, so the server never makes requests to user-supplied URLs.
