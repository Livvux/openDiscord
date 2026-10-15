# Public channels implementation plan

1. Add private-by-default publication and post projection tables (migration 0029 after assets 0028).
2. Add owner creation/terminal unpublish, safe bounded public read service and consent validation under community lock.
3. Thread explicit consent generation through app/API/bot/webhook send/edit and snapshot only explicitly public text.
4. Build persistent member notices, owner controls, uncached anonymous channel/directory/metadata/sitemap and authenticated public reporting.
5. Add focused PostgreSQL and browser coverage; verify via remote CI, review diff, push stacked draft PR. Merge/deploy remain root-owned.

Implementation uses native HTML route handlers for anonymous pages. They return escaped text only,
no client scripts, no private providers, no Next RSC/prefetch payload and explicit private/no-store
plus CDN no-store headers. Route-handler APIs and connection/cache guidance were checked in the
installed Next.js 16.4 docs; library queries follow local Drizzle source and existing repository patterns.
The bounded sitemap seeds the latest 30 active channels; the paginated directory links the rest.

Migration 0029 adds empty publication/projection tables only. No existing community is published.
Bots discover their consent generation in authenticated channel-list `publicPosting.generation`;
they must explicitly send it as `publicGeneration` in each public POST. Webhooks require the same
field; missing/wrong/stale generations fail closed. Do not automatically acknowledge a public post
in clients or integration deployments. Terminal unpublish requires a newly created channel to publish again.
