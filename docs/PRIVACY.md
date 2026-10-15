# Privacy and data handling

This describes what the software stores. Operators of an instance (including opendiscord.app) are the
data controllers and must publish their own privacy notice; this document is the technical basis for it.

## Encryption: what is and isn't protected

| Data | In transit | At rest | End-to-end encrypted |
| --- | --- | --- | --- |
| Community messages | TLS | Plaintext in Postgres (protect the disk) | **No** |
| Passwords | TLS | Salted hash (Better Auth, scrypt) | n/a |
| TOTP secrets, backup codes | TLS | Encrypted with `BETTER_AUTH_SECRET` | n/a |
| Passkeys | TLS | Public keys only | n/a |

**Nothing in openDiscord is end-to-end encrypted today.** The operator of an instance can technically
read community messages. In the application, instance administrators can explicitly review a reported
message only after providing a reason; access is audited. Global rights do not grant community membership. TLS and server-side storage protection are not E2EE, and the product must
never claim otherwise. E2EE direct messages are planned with an audited protocol ([DECISIONS.md](DECISIONS.md) D10).

## Data inventory

| Data | Purpose | Visible to | Retention |
| --- | --- | --- | --- |
| Email address | Sign-in, verification, password reset | The person and the operator | Until account deletion |
| Display name | Shown next to messages and in member lists | Members of shared communities | Until changed or deleted |
| Password hash | Authentication | Nobody (server only) | Until changed or deleted |
| Sessions: creation/expiry time, user agent | Keep you signed in; "signed-in devices" list | The person | Until expiry (7 days by default) or sign-out; expired rows are purged by a P1 job |
| IP addresses | Rate limiting | Nobody | **Not stored.** Sign-in/sign-up limits keep a keyed hash (HMAC) of "IP + endpoint" and a counter for at most a day; it can't be turned back into an IP without the server secret |
| Communities, memberships, roles | Running the community | Members | Until the community is deleted or you leave |
| Messages | Conversation | Members of the community | Until deleted by author, moderator, community deletion or account deletion |
| Images in messages | Conversation | Members of the community (served through the app, never public) | Re-encoded without EXIF/GPS on upload. Unreachable as soon as the message, channel, community or account is deleted; removed from storage within about an hour |
| Read markers (last read message per channel) and mentions | Unread markers, mention badges and notifications | The person only | Until the message, channel or account is deleted |
| Desktop-notification preference | Opt-in desktop notifications for mentions | Stored in the person's browser only (`localStorage`) | Until changed or browser data is cleared. Notifications show sender, channel and the start of the message on the device |
| Account approval status (Closed Alpha) | Access control | The person (on sign-in) and instance administrators | Until account deletion |
| Bans | Moderation | Moderators with ban permission | Until unbanned, community deleted or the banned account deleted |
| Audit log | Moderation accountability | Members with "view audit log" | Until community deletion; 180-day retention job P1. Never contains message content |
| Instance administrators, suspensions and settings | Instance governance and abuse prevention | Instance administrators; users see their own access restrictions | Until revoked; suspension ends when lifted or the account is deleted |
| Abuse reports: reporter, target IDs, reason, decision | Review member reports | Instance administrators | Retained until an operator retention process removes them; reporter/resolver links are removed on account deletion |
| Instance audit log | Administrative accountability | Instance administrators with a live authenticated session | Retained independently of community deletion; no automated retention job yet. Stores reasons and target IDs, never copies message bodies |
| Server logs | Debugging errors | Operator | Errors only; Caddy access logs are off by default |

There are no analytics, tracking pixels, advertising identifiers or third-party fonts. The Content
Security Policy blocks requests to other origins, with one optional exception: if the operator enables
Cloudflare Turnstile, the sign-up page loads Cloudflare's challenge script, and Cloudflare processes
the visitor's IP address and browser signals to tell people from bots. No other page loads it. If
the operator enables image attachments on Cloudflare R2, images are stored with Cloudflare as a
processor; visitors never contact R2 directly.

## Your rights (GDPR)

- **Access and portability:** Settings → Your data → Download my data (JSON: profile, sessions,
  security settings, memberships, owned communities, all your messages).
- **Correction:** change your display name in settings. Email change is P1.
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
