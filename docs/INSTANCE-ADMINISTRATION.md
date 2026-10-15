# Instance administration

Instance administrators manage the installation independently of community roles. A community owner or
moderator has no instance privileges. Instance administrators do not automatically become community
members and cannot browse private channels through their global role.

## First administrator

Create a normal account first, then run this operator-only command on the instance:

```sh
pnpm --filter web admin:bootstrap existing@example.com "Initial instance owner"
```

The command uses `apps/web/.env`, requires an existing, unsuspended account and refuses to run once an
administrator exists. It never creates an account or assigns rights by matching an email during login.
For containers or secret injection, run the script with the same `DATABASE_URL` as the installation.

Open `/app/admin` (shield icon in the community rail). Set up an authenticator app in account settings,
then confirm a TOTP code in administration. Confirmation unlocks the current session for 15 minutes.
The first account can enroll 2FA after bootstrap but cannot use administration before enrollment and
confirmation. Further admin grants require the target to have 2FA enabled already.

Only existing instance administrators can grant or revoke further rights. All operations verify the
live session, current role, suspension state, enabled 2FA and recent confirmation on the server.
Exporting an administrator's authenticator key or regenerating recovery codes also requires recent confirmation.
Invalid confirmation attempts are limited in PostgreSQL across processes and sessions. Administrators
cannot disable 2FA or delete their account while they retain the role. Demote them first. Concurrent
admin changes are serialized, and removing the last administrator is rejected.

## Operations

- **Users:** search by name/email, suspend/unsuspend, revoke every session. Suspension revokes sessions
  and blocks new sign-ins. Removing a suspension does not restore previous sessions. Admin accounts
  must be demoted before suspension.
- **Communities:** search by name, suspend/unsuspend, transfer ownership to an existing active member.
  The new owner must be below the configured ownership limit. Suspension preserves data while blocking
  member access, mutations, invite previews, joins and live message delivery.
- **Reports:** every member can report a community or a visible message. Reports go directly to
  instance administrators. Duplicate open reports are rejected and submissions are limited to ten per
  account per hour. Report lists contain metadata and reasons, never a copy of the message body.
  Opening a reported message requires a reason and writes an audit entry before returning its current
  content. Dismissing a report leaves content intact; removing it deletes the reported message or
  suspends the reported community. Deleted content is shown as unavailable.
- **Settings:** open/close account registration; permit community invitations by members with invite
  permission, restrict new invitations to instance admins with that community permission, or disable
  invitations including existing links. Registration and community membership are independent: closing
  registration prevents all new accounts, while existing accounts can still join through allowed
  invitations. Configure limits for owned communities, channels, roles and active invitations.
  Lowering limits does not remove existing data.
- **Audit:** actor ID/name, UTC timestamp, action, target and mandatory reason. Role changes, settings,
  session revocation, suspension, ownership transfer, report decisions, private-content access and
  admin confirmation are recorded. Mutations and their audit records commit atomically. No message
  bodies, credentials or session tokens are written into the instance audit log. Report reasons and
  operator reasons can contain personal information and should be written accordingly.

Lists show at most 50 matching users, communities or reports, and the latest 100 audit entries.
Search narrows account/community lists; report status selects open, dismissed or removed reports.
This first version has no arbitrary private-channel browser, account deletion tool or audit export.

## Data and rollback

The additive migration `0003_early_inhumans.sql` adds instance tables and community suspension fields.
It also prevents disabling an administrator's enabled 2FA at the database boundary, including races
with a role grant. Existing accounts and community roles are preserved. Back up PostgreSQL before
applying migrations. To roll back a release, retain these tables and deploy the previous application
version; do not drop moderation/audit evidence. An application rollback also removes enforcement of
these new instance suspensions, so assess active suspensions before rolling back.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e` against an isolated,
migrated PostgreSQL 18 test database. Integration suites run serially because settings apply across
all accounts. The admin E2E uses disposable accounts on desktop and mobile and checks real TOTP,
reporting, private-content review, removal, account/community suspension and accessibility.
