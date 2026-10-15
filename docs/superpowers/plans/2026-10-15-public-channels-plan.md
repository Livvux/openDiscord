# Public channels implementation plan

1. Add private-by-default publication and post projection tables (migration 0029 after assets 0028).
2. Add owner creation/terminal unpublish, safe bounded public read service and consent validation under community lock.
3. Thread explicit consent generation through app/API/bot/webhook send/edit and snapshot only explicitly public text.
4. Build persistent member notices, owner controls, uncached anonymous channel/directory/metadata/sitemap and authenticated public reporting.
5. Add focused PostgreSQL and browser coverage; verify via remote CI, review diff, push stacked draft PR. Merge/deploy remain root-owned.
