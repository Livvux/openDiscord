# Internal security findings and disposition — 2026-10-21

Baseline: `f4bb1f3c60a08b415a95aff6a5ccbe0138f09ff5`. Scope: hosted web/PWA application.
This is an internal source/integration review, **not** an external penetration test, independent
cryptographic audit, complete dependency-source audit or production security certification.
No confirmed Critical/High finding was established in the reviewed paths. Unreviewed surfaces and
external gates prevent treating that statement as a clean bill of health or Open Beta approval.

## Confirmed findings

| ID | Severity | Root cause and impact | Remediation / evidence | Disposition |
| --- | --- | --- | --- | --- |
| B1 | Medium | Several community/channel/category/invite/message management paths checked authority before a transaction, then committed after a concurrent permission revocation. A previously authorized moderator could complete an in-flight mutation using stale authority. This is not an anonymous privilege escalation. | #126 takes the existing community serialization lock and repeats current authorization inside each mutation transaction. Deterministic DB regressions pause after real early authorization, commit real role revocation, resume, then require forbidden and unchanged resources across eight actions. | Fixed in PR; baseline/main/production not yet patched |
| B2 | Low | Message rate limiting counted committed messages before a later serialized insert. Parallel requests, including across communities, could exceed the stated five-per-five-seconds author cap. The separate action/token limits still bound ordinary traffic; no unlimited flood claim. | #126 uses the existing PostgreSQL atomic sliding counter inside the message transaction. Parallel cross-community sends admit at most five. A missing-attachment regression requires rollback of both the message and consumed budget. | Fixed in PR; not merged/deployed |
| B4 | Low | Push subscription count and upsert were separate, allowing concurrent creation to exceed ten. Moving an already-known endpoint to another signed-in account also skipped the receiving account's cap. Endpoint possession is not treated as a victim-account takeover. | #126 serializes target-user count and upsert, counts transfers as new for that user, and preserves refresh of an already-owned endpoint at capacity. Concurrent and transfer/refresh integration checks use fresh fixtures and locally generated test VAPID keys. | Fixed in PR; not merged/deployed |

#126 head `7f772a4` passed full backend/browser/build/restore checks in
[CI 39647785737](https://github.com/Livvux/openDiscord/actions/runs/39647785737), strict
[Voice 39647785678](https://github.com/Livvux/openDiscord/actions/runs/39647785678) and
[scanner 39647785629](https://github.com/Livvux/openDiscord/actions/runs/39647785629).
Protected review and final integration remain required. A prior Voice SDK console failure remains
documented in the readiness matrix; its assertions were not weakened. No migration, dependency
or access-policy change is needed for these fixes.

## Controls reviewed and focused dynamic evidence

The focused investigators fully read 108 unique files under `apps/web`, plus supporting policy and
design documents. This is selected coverage; the architecture walkthrough is not counted as a full
line-by-line audit. Four baseline files were partially reviewed and substantial UI/other source and
dependency implementation remain outside full coverage. The private workbench retains detailed
path lists and counterevidence under scan `737ef9a4-9939-4347-b1f5-6eb3c96e5e57`, finalized
2026-10-21 18:03:38 UTC with a report, coverage ledger, findings and SARIF export. That sealed
report describes the baseline revision and partial review scope, not the later candidate or an
independent audit.

- Auth/session/account status, passkey/TOTP plugins and fresh-session reset controls; exact-origin
  cookie APIs and Next server-action boundaries; centralized community/channel/DM access checks.
- React/Markdown escaping, validated redirects, private generated storage keys, archive byte/record
  bounds, decoder/re-encoding, authorized downloads with sandbox/nosniff, configured fail-closed
  ClamAV and allowlisted HTTPS push endpoints. Operator-configured storage/SFU fetches remain
  external trust boundaries; there is no arbitrary user URL preview fetch.
- DM verified own devices, pinned peer identity changes, recipient/device roster invalidation and
  Megolm rotation, authenticated ciphertext/conversation/sender binding, replay ledger, opaque
  encrypted attachments, explicit recovery identity restore and terminal device revocation.
- Voice session/device/enrollment/nonce/generation binding, current channel/conversation authority,
  admitted native peers, audience/context agreement, worker key ACKs, supported GCM/source/codec
  checks, fail-closed publication/reception, reconnect/capture fencing and room cleanup boundaries.

`pnpm audit --prod --audit-level=high` found no known production advisories. The license declaration
gate accepted 130 package entries in nine declared groups; it is not professional license advice.
A signature/context scan of 4,800 tracked text files found no validated production credential;
fixtures/default interpolation were triaged. This is not a full-history/binary/entropy guarantee.
The documented encrypted archive checksum triggered a generic-key signature; it was confirmed to
be a public digest, not a credential. Public documentation was reworded without suppressing scans.

Current production ClamAV was contacted from the actual web namespace: loaded signatures 28160,
clean accepted and EICAR rejected. Unavailable-engine refusal is proven only in isolated real-engine
CI; do not stop production scanning to test it. Production authenticated upload acceptance remains
separate. Read-only checks and isolated synthetic fixtures never used customer sessions or altered
production account/access policy.

## Hardening and open questions

- #127 denies inline event attributes with `script-src-attr 'none'` and checks both blocked execution
  and working React form hydration in a browser. Inline Next bootstrap remains allowed. Installed
  Next 16.4 docs require dynamic rendering for nonce CSP and exclude current PPR/cache components;
  a nonce header alone would break the rendering contract. This residual risk is documented,
  not misrepresented as an exploitable XSS or a completed strict-nonce deployment.
- Category names may be visible through community-wide `ViewAuditLog` despite sidebar hiding.
  This requires an explicitly granted audit privilege and an unresolved metadata-confidentiality
  policy. It is not reported as a confirmed IDOR. Reviewers should settle the intended privilege
  boundary and test historical rename/delete records accordingly.
- Native DM SDK room-key forwarding/gossip defaults need a genuine native regression for removed
  group members who remain accepted/verified contacts. Source review did not establish a bypass;
  this is an independent-review question, not a fabricated confirmed vulnerability.
- TOFU, malicious operator-delivered JavaScript, compromised endpoints and already delivered
  plaintext/keys limit E2EE. Revoke cannot erase a recipient's previously obtained material; an
  already in-flight send may hold a prior roster. Public claims must state these boundaries.

## Independent and operational launch blockers

1. Independent cryptographic integration review: Matrix/native SDK defaults, recovery/device/group
   transitions, Voice key/audience/identity and SFU integrity/revocation assumptions. Attach dated
   reviewer, scope and exact release SHA; resolve findings and obtain explicit sign-off.
2. External authenticated pentest covering auth/CSRF/IDOR/XSS/uploads/resource abuse and actual
   deployed proxy/storage/SFU configuration. Internal agents do not supply this sign-off.
3. Legal/privacy/license/age-policy and international-transfer review by the responsible external
   reviewer, including real retention scheduling and deletion/export/abuse workflows.
4. Exact production image provenance, missing retention image, coherent Voice timers, backup
   capacity, actual alert/push delivery, physical Safari/Android and hostile TURN/screen-share
   acceptance. See [OPEN-BETA-READINESS.md](OPEN-BETA-READINESS.md) and
   [OPERATIONS.md](OPERATIONS.md). None is waived by source CI success.
