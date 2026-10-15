# Opt-in public text channels

Create new public text channels only, owner-only, with a separate explicitly selected public community title and acknowledgement that post display names, text and timestamps are searchable and may remain in third-party caches. Existing channels never convert. All database defaults and imported channels remain private.

A separate publication row contains the immutable consent generation and terminal unpublished timestamp. A separate public-post projection snapshots the author's display name, sanitized text and timestamp at explicitly acknowledged send time. Every send/edit path requires the current publication generation under the community lock; text only, with no attachments, replies, threads or private asset references. Unpublished channels cannot accept public posts or republish. Deletion cascades; edits update the public snapshot with consent. Private message DTOs and membership checks stay protected.

Anonymous directory/channel HTML pages, metadata and sitemap use bounded dedicated queries joining current publication, community and user state. No private community title, roster, account IDs, attachments or SSE. Generic mention fallbacks avoid resolving private identities. Public reading grants no membership or onboarding bypass. Authenticated nonmembers may report only currently public messages using existing reporting limits/storage.

UI has persistent composer/editor notices, explicit send acknowledgement and owner unpublish controls. Unpublish prevents subsequent reads after commit but cannot recall delivered content or external caches. Public routes must render at request time and send no-store headers including RSC.

Acceptance: PostgreSQL boundary/consent/race/suspension/deletion/export tests; desktop/mobile browser create, post, anonymous directory/read, report and unpublish; axe/console/network checks. No production community publication. No new dependencies. Heavy validation runs in CI only.
