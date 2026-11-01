# Hosted beta stabilization — 2026-11-01

Scope: hosted web application and installable PWA. Native desktop installers and native mobile
applications remain excluded. Public registration is enabled (`registration_open=true`,
`closed_alpha=false`). A versioned beta release is not yet certified or published.

## Verified starting state

- GitHub's default branch and the production checkout point to `f3c77fe5c199f1ee814c13982eb9a0d4ea65955c`.
  Dokploy adds routing labels and reformats its Compose file, so that checkout is dirty. The serving
  image's revision label is `unverified`; checkout equality does not establish image provenance.
  The existing read-only release smoke fails with `checkout-not-clean`.
- Public health and readiness return HTTP 200 when probed from the production server. This is not
  authenticated user-flow acceptance or proof of reachability from every external network.
- Retention, Voice repair, Voice monitoring and scanner monitoring have active schedules and recent
  successful completions. The actual LiveKit configuration sets `room.auto_create: false`.
- Required GitHub checks remain `check`, `voice-product` and `real-engine`, with strict up-to-date
  enforcement and administrator enforcement. Required approving-review count is zero. November 1
  reruns still fail before executing because GitHub reports an account billing lock.
- Central Backblaze B2 storage receives the database snapshots and the application's encrypted age
  recovery archives. The November 1 archive was read back from B2 and its SHA-256 matched the
  producer receipt. At inspection, the legacy app producer had a 512 MiB media cap while uploads
  permitted 50 GiB; its native B2 replacement is verified below.

## Candidate changes

- Optional `GLITCHTIP_DSN` enables allowlisted error diagnostics through a same-origin endpoint and
  server error boundaries. No error messages, account IDs, cookies, page URLs, request bodies,
  breadcrumbs or conversation content are sent. Reports contain error class, release revision,
  source category and bounded static-script locations. Browser ingestion is capped globally and
  request bodies are bounded. Reporting is optional for self-hosters.
- Both Compose variants forward the optional monitor destination and source revision. Standalone
  builds also forward the revision build argument. A source label is useful only after an actual
  clean build; relabelling an existing image is not release proof.
- The incremental backup producer accepts an operator-provided repository and password-file
  configuration, permitting Backblaze B2 without replacing the verified legacy archives.
- Root backup-output ignores are anchored, so source inventories include the existing DM recovery
  API. Route regression tests preserve
  authentication, device, owner, origin, JSON response and rate-limit boundaries.
- Public copy in all five marketing languages and support documentation describe public testing
  consistently, retaining the independent-audit and device-support limits. The privacy notice names B2 recovery storage and
  distinguishes snapshot retention from asynchronous provider cleanup.
- Pending delivery text keeps full contrast while the request is outstanding. A browser regression
  holds its own send request and checks accessibility before allowing successful delivery.
- Narrow navigation retains the brand symbol and signup control without overflowing. The
  wordmark stays visible at larger widths; a 375px regression covers all five marketing languages.

## Completed operator work and current validation

- **Backblaze cutover is live.** The daily producer now uses the dedicated native encrypted restic
  repository in B2. Its systemd EnvironmentFile and both backup/capacity-aware monitor scripts are
  installed. The scheduled job completed at `2026-11-01T07:12:58Z`: snapshot `8971fa39`, dump SHA-256
  `c3bc6f61dd72522c2332a48bd8e0ff6d736dbeaac43e653e46790774735b5fcc`.
  Both timers are active; the backup service succeeded and its operator monitor reports healthy.
  Legacy central B2 archives and rollback copies of the prior host scripts are preserved.
- **Actual B2 recovery passed in an isolated VM.** Snapshot `f4aac617` restored into a new PostgreSQL
  18 container, with all 45 ordered migration hashes matching and all four referenced media files
  present. A production-built app configured only with the restored database/media and isolated
  auth secret accepted the controlled QA account's login. Its verified session and protected `/app`
  route returned successfully; the avatar returned HTTP 200 and its 206 bytes matched the recovered
  object's SHA-256. SMTP, push, LiveKit and production object-storage credentials were not supplied
  to that restored application. This is a restore rehearsal, not a disaster RTO measurement.
- **Recovery keys retrieved independently.** After 1Password was unlocked, its stored restic password
  matched the existing recovery password. Its age identity also decrypted the preserved legacy B2
  archive. Backend credentials recovered from the separate central 1Password recovery record then
  restored scheduled snapshot `8971fa39` into another empty PostgreSQL container, with 45 matching
  migration hashes and all five attachment references present. These are writer credentials scoped
  to `restic/dokploy/`, not a dedicated read-only app key. The B2 bucket is private. An approved
  lifecycle rule removes only versions already hidden for one day under the dedicated app repository
  prefix; current objects have no upload-age expiry. Revision-guarded apply/readback preserved other
  bucket settings. Full repository integrity and retained-snapshot dump readback passed afterward.
  Actual provider deletion after the grace period has not yet been observed. This rehearses recovery
  access without borrowing keys from the source host.
- **Authenticated production browser acceptance:** real Turnstile signup, delivered verification
  email, verification, logout/login, delivered reset email, password reset and new-password login
  passed. A clean community image was uploaded, sent and read back; the harmless EICAR upload was
  refused by the actual app scanner (HTTP 400). The clean attachment returned HTTP 200, WebP and
  `nosniff`. Mobile-width pages had no horizontal overflow. The temporary QA community and account
  were deleted through the application and their absence confirmed in the database.
- **Monitoring:** the OpenDiscord GlitchTip project, alert and owner-team association are configured.
  The synthetic owner-routing event was ingested and its notification was found in the operator's
  connected mailbox, timestamp `2026-11-01T06:59:11Z`. The backup monitor's delivery test was accepted
  by SMTP; its inbox receipt has not been established. The candidate transport itself also delivered
  an allowlisted synthetic static-frame event from the isolated VM to GlitchTip; stored data contained
  no user, request or breadcrumbs. App diagnostic code
  is still a candidate and is not running in the production web image.
- **Final privacy browser readback:** the local production build served `/privacy` with HTTP 200.
  B2 storage, 30 daily copies, provider grace and optional diagnostics text were present. Desktop
  1280px and mobile 390×844 had no horizontal overflow. All 24 recorded requests succeeded; no
  console errors, with one unused-logo-preload warning. This does not deploy the notice to production.
- **Isolated static/unit validation:** frozen dependencies; lint passed with one existing ref-cleanup
  warning; typecheck and production build passed; 131 Vitest files completed with 1,129 passing and
  seven skipped tests. Seventeen new focused telemetry/DM-backup tests passed. Production dependency
  audit reported no known vulnerabilities. These manual results do not replace required GitHub checks.
  The dependency-license declaration check passed for 129 entries across nine license groups; this
  is a package-policy check, not a legal opinion.
  After the operator updated workload placement, final lint, typecheck and production build also
  passed on the MacBook using Node 22.23.4. The remote VM was subsequently used only for approved
  result readback and removal of task-owned services, credentials and restored data.
- **Focused browser validation:** the initial Chromium desktop/mobile run had 18 passes, six
  intentional skips and two failures; corrected search/public-channel paths passed three cases (one intentional mobile-search
  skip). Firefox and WebKit auth, community and diagnostics journeys passed 16 cases with two
  intentional mobile-only skips. No retries were used. Manual runs used a 60-second default on the
  isolated two-CPU VM; repository defaults and individual existing test deadlines were preserved.
  The first broad Chromium attempt was stopped after 99 passes because its setup lacked LiveKit;
  it also exposed stale assertions corrected here. It is not a completed full-suite pass.
- **Completed broad Chromium run:** 220 passed, 49 skipped and five failed, with no retries. GIF
  consent and mobile emoji assertions acted on optimistic rows before server acknowledgement;
  the profile/DM case encountered temporary screenshot-storage exhaustion. Persisted-row assertions
  and a task-scoped browser temporary directory passed 14 focused repeated cases, with two
  intentional skips. The closed-alpha admission test passed separately. These corrected reruns do
  not constitute a fresh complete green Chromium run.
- **MacBook follow-up:** a complete two-worker run finished with 205 passes, 49 skips and 20
  failures, without retries. One failure exposed a real pending-message contrast defect, reproduced
  deterministically in desktop and mobile tests before the fix. Removing row opacity restored text
  contrast while preserving explicit delivery labels. Final lint, typecheck and build passed; the
  final focused message/thread/marketing rerun passed 21 cases with one intentional skip, including
  all five languages at 375px. One native-media test stopped at its strict fixture guard because
  the test process used the wrong auth origin;
  the corrected-origin rerun passed the genuine three-account MediaSession test on macOS with no
  retries, including worker acknowledgements, listen-only grants and Opus/VP8 decoding. The other
  18 failures were video acceptance cases with low rendered-frame counts despite encoded-frame
  activity. Their cause remains
  unverified; no crypto assertion or product behavior was changed to conceal them.
- **Native Voice repeat remains open:** the Linux broad run's remaining failure is the three-account
  native MediaSession test. Fixed sleeps were replaced by observable SAS readiness, and token
  observation uses the existing 26-second three-peer production keying budget. A two-worker,
  three-repeat run still produced one pass and two failures on the isolated two-CPU VM, including
  context expiry before media readiness. Diagnostics recorded no capture or token issuance in that
  failed initial epoch. The same test then passed three serial repetitions without skips or retries;
  that single-call evidence does not close concurrent-load acceptance. A fresh complete suite
  remains a release gate. Production crypto timers and
  admission checks were not changed.
- **Voice:** 34 isolated Chromium cases passed against the real local LiveKit service, including
  HTTP enrollment, denied permissions, three-account listen-only media sessions, actual SFU
  audio/video encryption boundaries and reconnects. No retries or skips. Synthetic devices remain
  narrower evidence than physical microphone/camera/screen-share and restrictive-network acceptance.
- **Two-replica characterization passed:** 20 authenticated SSE readers split between two standalone
  processes, 3,000 history messages, 100 reads, 17 writes and 320 fanout receipts. Both replicas denied
  outsider reads/streams, reconnect across replicas received its sentinel, and stream leases and
  fixtures were cleaned up. Read/write/fanout p95 were 362.99/62.97/131.58 ms; sampled process RSS peaks
  were 203,180/202,224 KiB. CPU, media, browser rendering, failover and production SLOs were not measured.
- **Internal source review is partial:** 101 of 375 tracked source files reviewed, zero confirmed
  findings in that scope, 274 files explicitly deferred. The new diagnostics received separate code
  and TypeScript review. This does not establish the absence of vulnerabilities or replace external
  crypto, penetration, privacy or legal review.

## Release acceptance still required

1. Clear the account billing lock and execute all required checks on the final candidate revision.
   Manual isolated validation is separate evidence and does not authorize bypassing protection.
2. Agree recovery-time/data-loss objectives and rehearse full infrastructure recreation against them.
   The B2 cutover, actual DB/media/app restore and independent 1Password recovery credentials above
   are verified. Preserve legacy archives/keys; consider a dedicated read-only app recovery key.
3. Build and deploy immutable web/migrate images from the reviewed clean source. Verify the serving
   image, all ordered migration hashes, HTTP contracts and public/authenticated browser journeys.
   Preserve Dokploy-managed routing configuration rather than resetting it to make a smoke pass.
4. Record Web Push receipt, real microphone/camera and received screen share, restrictive-network TURN and physical iOS Safari/Android Chrome/PWA flows.
   Synthetic devices and emulation remain narrower evidence. Include assistive-technology checks.
5. Commission external cryptographic integration, authenticated penetration and legal/privacy/license
   reviews. Internal source review is not any of these sign-offs. Freeze the exact release revision
   and retain reviewer, date, scope, findings and resolutions.
6. Establish supported load and recovery objectives on a representative isolated deployment. A
   20-reader characterization does not establish production capacity. Include backup retention
   growth, storage churn and abort/alert thresholds rather than relying only on live media size.
   Resolve the native concurrent-repeat and macOS video acceptance failures, then run the complete
   final browser suite green;
   do not classify a failed concurrent repeat as capacity certification.
7. Publish the beta tag, changelog, supported-platform matrix and known limitations only after the
   required evidence is complete. Registration being open does not close these release gates.

## External review packet

Use [THREAT-MODEL.md](THREAT-MODEL.md), [PRIVACY.md](PRIVACY.md),
[PRIVATE-MESSAGES.md](PRIVATE-MESSAGES.md), [voice/call-session.md](voice/call-session.md),
[OPERATIONS.md](OPERATIONS.md), [DEPENDENCY-LICENSES.md](DEPENDENCY-LICENSES.md) and
[SECURITY.md](../SECURITY.md) with the frozen source revision.
Focus the crypto review on device trust, room-key forwarding defaults, late group membership,
revocation, recovery/identity changes and fail-closed Voice generations. Native SDK implementation
and physical browser behavior need separate evidence. Review official operator disclosures,
minimum-age policy, moderation/appeals, data-subject rights, retention and dependency licensing.

Provide reviewers with disposable fixture accounts and an isolated environment. Require a dated
report identifying the reviewer, exact full commit, tested deployment/configuration, methods,
reproductions, severity, residual limits and finding disposition. Confirm actual provider contracts,
transfer arrangements and distribution obligations rather than treating the package declaration
allowlist or technical privacy inventory as legal approval.

No external reviewer has signed off in this work. No Critical/High absence claim is made for
unreviewed source, dependency implementations or untested deployment behavior.
