# Privacy and data handling

This describes what the software stores. Operators of an instance (including opendiscord.app) are the
data controllers and must publish their own privacy notice; this document is the technical basis for it.

## Encryption: what is and isn't protected

| Data | In transit | At rest | End-to-end encrypted |
| --- | --- | --- | --- |
| Community messages | TLS | Plaintext in Postgres (protect the disk) | **No** |
| Passwords | TLS | Salted hash (Better Auth, scrypt) | n/a |
| TOTP secrets, backup codes | TLS | Encrypted with the configured Better Auth secret/keyring | n/a |
| Direct messages | TLS and client encryption | Ciphertext in Postgres; browser crypto state in IndexedDB | **Yes**, between verified devices; see [PRIVATE-MESSAGES.md](PRIVATE-MESSAGES.md) |
| Passkeys | TLS | Public keys only | n/a |

Community messages are readable by the instance operator. In the application, instance administrators
can explicitly review a reported community message only after providing a reason; access is audited.
Global rights do not grant community membership. Direct messages use Matrix crypto between verified
browser devices, with no plaintext fallback. A recipient can explicitly disclose a decrypted message
when reporting it. Recovery copies are bounded to loaded, authenticated messages, not a complete history
backup. Malicious operator-delivered JavaScript or a compromised device can access plaintext; the
integration has not received an independent cryptographic audit. Voice remains encrypted in transit,
not end-to-end. See [PRIVATE-MESSAGES.md](PRIVATE-MESSAGES.md) and [DECISIONS.md](DECISIONS.md) D10.

## Data inventory

| Data | Purpose | Visible to | Retention |
| --- | --- | --- | --- |
| Email address | Sign-in, verification, password reset | The person and the operator | Until account deletion |
| Display name | Shown next to messages and in member lists | Members of shared communities | Until changed or deleted |
| Password hash | Authentication | Nobody (server only) | Until changed or deleted |
| Sessions: creation/expiry time, coarse browser/platform label | Keep you signed in; "signed-in devices" list | The person | Until expiry (7 days by default) or sign-out; expired rows are purged by the operator maintenance job |
| IP addresses | Rate limiting | Nobody | **Not stored.** Sign-in/sign-up limits keep a keyed hash (HMAC) of "IP + endpoint" and a counter for at most a day; it can't be turned back into an IP without the server secret |
| Communities, memberships, roles | Running the community | Members | Until the community is deleted or you leave |
| Public channel publication state and post snapshots | Explicit opt-in public text communication | Anyone while published; search engines and third-party caches may retain copies | Only new owner-created channels can publish. Posting/editing requires current channel acknowledgement; public titles and send-time names are snapshots. Unpublishing immediately hides app public output and is terminal. Retained snapshots are deleted with original messages/accounts or community deletion and are included in the author's personal export; current owners receive publication state in theirs |
| Messages | Conversation | Members of the community; explicitly acknowledged posts in new public channels also have a public snapshot | Until deleted by author, moderator, community deletion or account deletion |
| Images and files in messages | Conversation | Members of the channel (served through the app, never public) | Images are re-encoded without EXIF/GPS; other files are stored unchanged and served as downloads. Unreachable as soon as the message, channel, community or account is deleted; removed from storage within about an hour |
| Community emoji and stickers | Community communication | Current community members through private app delivery | Re-encoded static images without metadata. Community-owned; account deletion drops uploader attribution and preserves the library. Asset or community deletion makes files inaccessible and eligible for storage cleanup |
| Read markers (last read message per channel) and mentions | Unread markers, mention badges and notifications | The person only | Until the message, channel or account is deleted |
| Desktop-notification preference | Opt-in desktop notifications for mentions | Stored in the person's browser only (`localStorage`) | Until changed or browser data is cleared. Notifications show sender, channel and the start of the message on the device |
| Online status (opt-in) and last-seen time | Show "online" to members of shared communities | Members of shared communities, only while the person has it switched on | `last_seen_at` is overwritten on each heartbeat (no history); deleted with the account |
| Notification level per community | Mute communities | The person only | Until changed, leaving or account deletion |
| Voice audio, camera video and screen shares | Live conversation in voice channels | People in the same voice channel | Never stored: relayed live by the operator's LiveKit server (encrypted in transit, not end-to-end) |
| Push subscriptions (per device, opt-in) | Mention notifications when openDiscord isn't open | The person; the browser's push service (Google, Mozilla, Apple or Microsoft) receives an end-to-end encrypted payload and sees only that a push happened | Until switched off on the device, the push service reports it gone, or account deletion |
| Community exports | Moving a community to another instance | The owner who downloads it | Generated for download; each export is recorded in the audit log. JSON version 2 includes library metadata and readable image fallbacks without files; complete gzip archive version 3 includes all live library files including unused images. Archives are compressed, not encrypted, and do not replace operator backups. Contains display names and messages, optionally their files; account records and email fields are excluded, but message/file contents may contain personal data. Failed imports can leave private, unlinked files eligible for cleanup after one hour |
| Bots and webhooks | Integrations a community set up | Members see their messages (labelled BOT); managers see name, target channel and last use | Until revoked; their accounts are deleted with the community |
| Blocked people | Hide their messages, silence their mentions | The person only; the blocked person is not told | Until unblocked or either account is deleted; included in the data export |
| Account approval status (Closed Alpha) | Access control | The person (on sign-in) and instance administrators | Until account deletion |
| Bans | Moderation | Moderators with ban permission | Until unbanned, community deleted or the banned account deleted |
| Audit log | Moderation accountability | Members with "view audit log" | Until community deletion or 180-day retention through the operator maintenance job. Never contains message content |
| Instance administrators, suspensions and settings | Instance governance and abuse prevention | Instance administrators; users see their own access restrictions | Until revoked; suspension ends when lifted or the account is deleted |
| Abuse reports: reporter, target IDs, reason, decision | Review member reports | Instance administrators | Open reports remain until resolved; resolved reports are purged 180 days after resolution by maintenance. Reporter/resolver links are removed on account deletion |
| Instance audit log | Administrative accountability | Instance administrators with a live authenticated session | Retained independently of community deletion; 180-day retention through the operator maintenance job. Stores reasons and target IDs, never copies message bodies |
| Server logs | Debugging errors | Operator | Errors only; Caddy access logs are off by default |

There are no built-in analytics, tracking pixels, advertising identifiers or third-party fonts.
The Content Security Policy restricts third-party requests. If the operator enables Cloudflare
Turnstile, the sign-up page contacts Cloudflare, which processes the visitor's IP address and
browser signals. If image attachments use Cloudflare R2, the server accesses R2 privately;
visitors never contact the storage bucket directly.

If the operator configures KLIPY or GIPHY, opening the GIF picker sends search terms, IP
address and browser request metadata to the selected provider. KLIPY may receive a GIF
share interaction. GIF messages are stored as externally hosted URLs (and E2EE direct
messages encrypt the URL); the GIF file is not uploaded to the instance. Loading an
external GIF requires an explicit click before the provider receives the viewer's IP
address and request metadata. Provider privacy terms apply; their GIFs may become
unavailable independently of the instance.

## Your rights (GDPR)

- **Access and portability:** Settings → Your data → Download my data (JSON: profile, sessions,
  security settings, memberships, owned communities, all your messages).
- **Correction:** change your display name in settings. With SMTP configured, change your email after a recent sign-in: a verified current address must approve the change, then the new address must be verified. Without SMTP, email changes are disabled.
- **Erasure:** Settings → Delete account. This permanently deletes your account, sessions, 2FA and
  passkeys, memberships, bans against you, and every message you wrote. Audit entries about you keep the
  action but lose the link to your account. If you own communities, delete them first, so members
  aren't left with an ownerless community. Instance administrators must first have their global rights
  removed by another administrator; the last admin cannot be removed. Instance moderation records are
  retained for accountability: actor/reporter links become null when the account is deleted, while
  target IDs and free-text reasons remain. Operators must define appropriate retention and handle
  requests concerning these records. They are not part of the self-service JSON export.
- **Restriction/objection:** there is no profiling or optional processing to object to.

## Search engines and public access

Private areas (`/app`, `/invite`, `/api`) are excluded via `robots.txt` and `noindex`. Community-content APIs
require membership. Instance administration separately requires global rights and a live authenticated session. Public, indexable channels will exist only as an explicit opt-in (P2).

## Backups

Backups made with `scripts/backup.sh` contain all of the above. Store them encrypted, restrict access,
and delete them on a schedule; deleted accounts disappear from the live database immediately and from
backups when those expire.

## Scheduled maintenance

The operator must schedule `pnpm maintenance --apply` (or invoke the script directly as described in
SELF-HOSTING.md). Without `--apply`, it only reports aggregate counts. Each run removes expired sessions
and verification records, rate-limit windows older than one day, expired connection leases, audit logs
older than 180 days, and reports and ban appeals resolved more than 180 days ago. It also replaces legacy raw session
user agents with coarse browser/platform labels and removes legacy session IP fields. Active sessions,
open reports, accounts and messages are not deleted. Batch limits bound each run; a nonempty `limited`
list means more work remains for the next run. New sessions and updates containing device metadata also minimize it; existing raw metadata is scrubbed by maintenance.

Personal export version 8 includes community image upload attribution separately from personal messages, the person's retained public post snapshots (including their send-time display name), and public-channel publication state for communities they currently own, including withdrawn publications. Other authors' snapshots are excluded. Custom image references in personal message exports become readable text. Library ownership remains with the community, independently of the uploader account.
