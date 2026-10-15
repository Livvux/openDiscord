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

### Posting to explicitly public channels

The channel list includes `publicPosting` (null for private channels) and `publicPostNotice`.
For a public channel, review that notice and deliberately include its current
`publicPosting.generation` as `publicGeneration` in the message body. This acknowledges that the
text, send-time display name and timestamp are public and searchable. Do not automatically opt an
existing integration into public posting. Missing or stale acknowledgement is rejected; a channel
with `publicPosting.unpublished: true` permanently rejects writes. Existing private channels keep
their previous request format.

```json
{ "content": "An explicitly public announcement", "publicGeneration": "<current channel generation UUID>" }
```

Public channels accept text only, without attachments, custom community images, replies or threads.
Only an owner can create a new public channel in the app; existing private channels and histories
cannot be converted. Public HTML discovery does not grant a bot membership or API access.

## Incoming webhooks

A webhook posts plain messages into one text channel and holds no other rights:

```sh
curl -H "Content-Type: application/json" -d '{"content":"Build #42 passed"}' \
  https://example.org/api/webhooks/$ID/$TOKEN
```

Mentions are turned into plain names: webhooks can't ping or badge anyone. AutoMod always applies. Unknown, revoked and mismatched URLs all
answer `404`.

Webhooks targeting a public channel also need an explicitly configured `publicGeneration` in their
JSON body. An authorized community member can read it in the channel listing with a bot token.
Use the same deliberate opt-in and current-state rules above; a webhook token does not bypass them.

## Tokens

Tokens are shown once and stored only as SHA-256 hashes. Revoking a bot or webhook stops its token at
once (a bot also leaves the community); past messages stay and keep their *BOT* label. There are no
outgoing webhooks, so the server never makes requests to user-supplied URLs.
