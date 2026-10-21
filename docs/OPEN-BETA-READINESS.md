# Open Beta readiness

Evidence date: 2026-10-21. Scope: hosted web application and installable PWA.
Desktop installers and native mobile applications are excluded. **Decision: NO-GO.**
Closed Alpha stays enabled. No public beta release or announcement is authorized.

PASS means executed evidence satisfies the stated criterion. FAIL means a demonstrated defect or
missing required control. UNVERIFIED means execution/sign-off is missing, including tests that were
only described or skipped. A P0 UNVERIFIED gate blocks release just like a P0 FAIL.
Historical evidence is dated and does not certify the current candidate.

## Revision and production truth

| Item | Observed evidence | Status |
| --- | --- | --- |
| Baseline `main` | `f4bb1f3c60a08b415a95aff6a5ccbe0138f09ff5`; no open PRs at start | PASS |
| Baseline CI | [CI 39474419060](https://github.com/Livvux/openDiscord/actions/runs/39474419060), [Voice 39474418779](https://github.com/Livvux/openDiscord/actions/runs/39474418779), [scanner 39474418988](https://github.com/Livvux/openDiscord/actions/runs/39474418988), [native Linux 39474418823](https://github.com/Livvux/openDiscord/actions/runs/39474418823): success on baseline SHA | PASS, baseline only |
| Production checkout | Read with `sudo git rev-parse HEAD` in the deployed Dokploy checkout: baseline SHA | PASS, checkout only |
| Running web image | `sha256:7c787e4c5507f9768c53d489dfb098f54da7920fc4ab9bf73069e6533e3b4de4`, created 2026-10-20 18:26:54Z. No OCI revision label. Checkout equality does not prove image provenance. | UNVERIFIED SHA binding |
| Migration journal | Read-only comparison: all 40 ordered production journal hashes equal SHA-256 of the baseline SQL files, through `0039_dm_calls`; newest timestamp `1792407256144` | PASS baseline journal |
| Public probes/PWA | Collaborative Chromium browser: `/api/health` 200 `no-store`, `/api/ready` 200 `no-store`, `/manifest.webmanifest` 200 `application/manifest+json` | PASS |
| Candidate delivery | Four small readiness PRs below. No merged release commit, beta tag or matching candidate deployment exists. | UNVERIFIED |

## P0 release gates

| ID | Gate and acceptance criterion | Current evidence / remaining action | Status |
| --- | --- | --- | --- |
| S1 | No unresolved Critical/High vulnerabilities; dependency, license, static and focused dynamic checks on release SHA | No confirmed Critical/High in the bounded internal review; this is not a completeness claim. Production dependency audit reports no known advisories; 130 production package declarations / 9 license groups accepted. See [findings](SECURITY-FINDINGS-2026-10-21.md). Independent/final-SHA gates remain. | UNVERIFIED |
| S2 | Auth/session/passkey/2FA, tenant authorization, CSRF, XSS, SSRF, uploads and rate limits reject abuse with regression evidence | Confirmed stale-authority mutation, message-cap and push-cap races fixed/tested in #126; not merged/deployed. Prior-head full CI passed. Final integration must repeat auth/IDOR/origin/upload negative cases. | FAIL baseline races; fixes in review |
| S3 | DM 1:1/groups/attachments/recovery/device revocation fail closed, no unintended plaintext fallback | Focused internal integration review found no confirmed fallback/key-disclosure bypass. Native/browser tests exist and execute in CI; independent crypto review, SDK key-forwarding follow-up and physical cross-device acceptance remain open. | UNVERIFIED |
| S4 | Voice E2EE/SFU authorization/key revocation fail closed through reconnect and membership changes | Baseline Chromium/Firefox product acceptance green. Independent crypto integration sign-off, successful screen-share reception and hostile-network TURN acceptance missing. | UNVERIFIED |
| S5 | CSP exposure characterized and public encryption claims accurate | #127 adds `script-src-attr 'none'`, browser hydration/blocked-handler proof and corrected group/attachment/Voice claims; production still needs deployment. Nonces require dynamic rendering and conflict with current PPR per local Next docs. Inline bootstrap remains a documented residual risk. | FAIL deployed claims; fix in review |
| S6 | Independent crypto audit and external penetration test signed off | Owner must commission independent reviewers, fix findings and attach dated scope/revision/sign-off. Internal agent review is not independent cryptographic assurance. | UNVERIFIED, external |
| F1 | Registration, verification email, login/logout/recovery/passkeys/2FA work on supported browsers | Baseline CI and historical RC1; delivered verification/reset emails and physical browser flows still need actual evidence. | UNVERIFIED |
| F2 | Alpha→beta policy preserves pending/rejected states, anti-spam and admin controls | Existing isolated Closed Alpha suite; production policy must stay unchanged until explicit owner approval. Rehearse transition on disposable data only. | UNVERIFIED |
| F3 | Friends/profiles/communities/roles/invites/moderation; messages/attachments/reactions/threads/search/unread/notifications pass | Full Chromium desktop/Pixel 7 baseline and #127 head `599f009` main CI pass. #125 adds repeatable Firefox/WebKit/Edge/iPhone journeys; failures in its new diagnostic calibration are being corrected, with full rerun required. | UNVERIFIED final integration |
| F4 | Supported desktop browsers and mobile user journeys, accessibility/keyboard/screen-reader/loading/error/offline behavior accepted | RC1 contains real harness gaps and skipped mobile tests. New CI covers bounded Firefox/WebKit/Edge/iPhone-emulation journeys; emulation is not physical acceptance. | UNVERIFIED |
| F5 | Real iOS Safari and Android Chrome, PWA install/relaunch/recovery/storage, mobile encrypted DMs/groups/files/calls accepted | Physical devices unavailable to this run. Operator must record OS/browser/device versions, exact SHA, steps and results. | UNVERIFIED, physical devices |
| F6 | Real microphone/camera, successful screen-share publication/reception, reconnects and TURN/TLS through restrictive networks accepted | Existing denial and fake-device Opus/VP8 evidence is narrower. Requires two real endpoints and a controlled UDP-blocked network. | UNVERIFIED, operator/device/network |
| O1 | Backups remain viable at allowed beta storage capacity; safe limits enforced | Today's backup succeeds but 512 MiB media RAM budget and 1 GiB retained-full-bundle cap still allow accepted uploads to exceed recovery capacity. One 100 MB message × 31 dailies exceeds the cap. Warning-only #117 did not resolve this. | FAIL |
| O2 | Encrypted DB/media/config backup, retention, independent restore, restored app boot and media readback proven | Actual 2026-10-21 off-host bundle restored on isolated PostgreSQL 18.6: 40 migrations, 3 users, 1 community, 22 messages, 1 avatar. Exported production app booted, isolated fixture signed in, authenticated avatar read returned identical 12,312 bytes. Temporary secrets/data/daemon removed. [Recovery evidence](OPERATIONS.md#hosted-instance-restore-evidence-2026-10-21). Scale/capacity remains O1. | PASS bounded actual data |
| O3 | Production scanner active, signatures fresh, clean/EICAR and outage fail-closed proven | From actual web namespace: ClamAV 1.5.4 signatures 28160 dated 2026-10-21 06:25:49, clean accepted, EICAR rejected. Isolated real-engine CI proves unavailable-engine refusal. Actual authenticated production upload remains unverified; never stop the production scanner as a test. | UNVERIFIED full app path |
| O4 | Scheduled retention and Voice maintenance complete, independent health/backup/scanner/Voice alerts delivered | Hourly retention currently fails: missing `compose-index-virtual-microchip-f3zupk-migrate:latest`. No Voice maintenance/monitor timer observed. Backup/scanner healthy does not cover these failures. | FAIL |
| O5 | SMTP and Web Push actual delivery, storage, LiveKit/TURN and scheduled maintenance checked | Synthetic operator alert accepted by SMTP on 2026-10-21; recipient inbox confirmation missing. Actual push receipts, Voice repair scheduling and complete service acceptance missing. No delivered-mail claim. | UNVERIFIED |
| O6 | Realistic HTTP/SSE/DB/media characterization, enforced beta limits and rollback triggers | Synthetic read/HTTP/SSE CI workloads exist; not a production concurrency guarantee. No measured supported-user/media-bandwidth limit yet. Keep restricted Alpha. | UNVERIFIED |
| R1 | `main` rejects direct/force writes, needs review and successful checks | Applied/read back 2026-10-21: required `check`, `voice-product`, `real-engine` from GitHub Actions; strict up-to-date branch; 1 approval, last-push approval, stale approvals dismissed; admins included; force/deletion disabled; conversations resolved. Only Livvux currently has write rights, so a separate reviewer identity is required. | PASS protection; review prerequisite external |
| R2 | Exact release SHA passes all required checks and matches production/migrations/services | Baseline green is insufficient for changed candidate. No beta tag or release is published. | UNVERIFIED |
| R3 | Imprint/privacy/terms/age/guidelines/abuse/GDPR/support accurate and legally signed off | Public routes respond, but current legal approval is absent. Software text and an age checkbox are not counsel sign-off. | UNVERIFIED, external |
| R4 | Versioned release, changelog, support/security disclosure, deploy/rollback/incident smoke runbook ready | #128 adds [runbook](RELEASE-RUNBOOK.md), [unreleased changelog](../CHANGELOG.md), [support policy](../SUPPORT.md), labelled web/migrate builds and read-only deployment smoke. SECURITY.md already defines private disclosure. No published beta/native release. | UNVERIFIED merge/deploy |

## P1 and P2 follow-up checklist

These do not waive any P0 above. A Critical/High finding discovered in follow-up becomes P0.

| Priority | Item / acceptance criterion | Evidence | Status |
| --- | --- | --- | --- |
| P1 | Reduce inline bootstrap exposure further only with compatible Next rendering and hydration evidence | Event attributes denied in #127; strict nonce rendering would change PPR/cache behavior. Dedicated design/performance validation remains. | UNVERIFIED |
| P1 | Extend full feature parity across supported engines and preserve diagnostic evidence | #125 adds a bounded gate; skips, WebKit service-worker block and synthetic media limits are explicit. Retain artifacts before their short CI expiry. | UNVERIFIED |
| P1 | Review category-name visibility under the community-wide audit-log privilege | Reachable metadata requires `ViewAuditLog`; confidentiality policy is ambiguous, so this is not a confirmed bypass. Independent reviewer must settle policy/test it. | UNVERIFIED |
| P1 | Measure larger histories and identify a justified virtualization threshold | Existing pagination/content-visibility and bounded load scripts; no measured large-history requirement established. | UNVERIFIED |
| P2 | Trusted desktop publisher signing/notarization and native runtime acceptance | Outside hosted launch; do not publish unsigned/unverified artifacts. No GitHub release currently exists. | UNVERIFIED, excluded scope |
| P2 | Native mobile clients and wider feature parity | PWA is launch scope; native mobile is not implemented or promised. | UNVERIFIED, excluded scope |

## Capacity decision required before admission changes

Do not simply remove the 1 GiB cap or omit media from recovery. Two defensible options need an
operator-approved budget and a rehearsal with actual incompressible DM-sized objects:

1. Encrypted incremental off-host media storage with immutable object hashes, a snapshot manifest,
   retained object references, bounded upload admission, integrity readback and isolated object+DB
   restoration. Evaluate a mature encrypted snapshot tool such as restic; do not roll a crypto format.
2. Fund and enforce a larger full-bundle budget covering **31 × maximum recoverable snapshot size**,
   database/config growth and lifecycle lag; match global upload/storage limits and tmpfs headroom.

Neither a larger number in a script nor an early warning proves purchased/available capacity,
restore performance or admission enforcement. Until chosen, installed and proven, O1 remains FAIL.

## Test evidence matrix

| Environment / journey | Result | Evidence and limits |
| --- | --- | --- |
| Baseline Linux Chromium desktop + Pixel 7 emulation | PASS baseline | CI 39474419060; candidate must rerun |
| Baseline Linux Chromium/Firefox three-account encrypted media and DM calls | PASS baseline | Voice product run linked above; synthetic devices, loopback SFU |
| Baseline real ClamAV engine | PASS baseline | Scanner workflow linked above; isolated, not production browser uploads |
| Historical macOS Firefox/WebKit/iPhone emulation | MIXED | [QA-RC1-2026-10-20.md](QA-RC1-2026-10-20.md); failures/flakes/skips remain explicitly recorded |
| #126 prior head `3122c5e` | PASS prior head | [CI 39639579791](https://github.com/Livvux/openDiscord/actions/runs/39639579791): both backend shards, full Chromium, encrypted DB/media restore, build and aggregate green. Latest head adds an attachment rollback regression and requires its own checks. |
| #127 head `599f009` | PASS CI | [CI 39641382406](https://github.com/Livvux/openDiscord/actions/runs/39641382406): both backend shards, all three Chromium shards, Docker/media recovery and `check` green. CSP blocked-handler + real form hydration assertions executed. Separate Voice/scanner checks and later changes remain independently gated. |
| New Firefox/WebKit/iPhone-emulation/Edge gate | FAIL then rerun required | [CI 39641263103](https://github.com/Livvux/openDiscord/actions/runs/39641263103), head `bf57ef3`: calibration expected the uncaught error without Chromium's prefix; actual error/rejection were captured. Corrected expectation must rerun. Config collects 88 cases/14 files on this branch; some intentionally skip phones. WebKit blocks SW; Chromium PWA acceptance is separate. |
| Current public production in collaborative Chromium | PASS bounded | Home 1280×800 and sign-in 1280×800 / 390×844 have no horizontal overflow; health/ready/manifest contracts pass, no relevant console error or failed sign-in-page network request. Preload warnings observed. No authenticated-production or physical-device claim. |
| Actual isolated production recovery | PASS bounded | 2026-10-21 bundle decrypt/restore/app health/login/authenticated avatar readback; network-isolated fixtures only, all temporary material removed. Does not prove nonexistent DM media or future scale. |
| Real Safari, iOS Safari, Android Chrome, assistive technology | UNVERIFIED | Physical/real-device acceptance is outstanding |
| Real push, email inbox, hostile TURN, screen-share reception | UNVERIFIED | Separate service/device/network evidence required |

## Release ledger and operator handoff

| PR | Scope | Delivery state |
| --- | --- | --- |
| [#125](https://github.com/Livvux/openDiscord/pull/125) | Readiness ledger, required cross-browser CI, runtime diagnostics and friend-flow synchronization | Open; latest exact head checks and separate approval required |
| [#126](https://github.com/Livvux/openDiscord/pull/126) | Transactional authorization and atomic message/push caps with regressions | Open; latest exact head checks and separate approval required |
| [#127](https://github.com/Livvux/openDiscord/pull/127) | CSP event-attribute denial and accurate public/privacy/encryption copy | Open; later copy changes require fresh CI and approval |
| [#128](https://github.com/Livvux/openDiscord/pull/128) | Production source/migration/header proof, maintenance monitoring, actual recovery and release runbook | Open; latest exact head checks and separate approval required |

**Merge commits: none. Final release SHA: not established. Candidate deployment: not performed.**
Protection must not be bypassed. Only the author currently has repository write rights, so the owner
must provide a distinct eligible reviewer before validated PRs can merge. Merge #125 first so its
additional required browser gate applies to the final integration, rebase/update subsequent PRs,
and require final-main CI and production readback. Do not infer deployed changes from PR success.

External/operator actions: commission and attach crypto/pentest/legal sign-offs (S6/R3); supply
physical-device, assistive-technology and restrictive-network evidence (F4–F6); approve and prove
backup capacity (O1); restore the reviewed migrate image and activate coherent Voice scheduling
(O4); confirm actual inbox/push delivery (O5); establish measured beta admission limits (O6).
These are launch blockers, not claimed completed work or requests to bypass protections.

To change this decision to GO, close every P0 row with dated evidence on the final SHA, include
the external crypto/pentest/legal sign-offs and physical acceptance, prove the matching production
deployment/recovery, then obtain the owner's explicit approval for the admission-policy change.

References: [RC1 QA](QA-RC1-2026-10-20.md), [prior acceptance](ACCEPTANCE-2026-10-19.md),
[internal audit](SECURITY-AUDIT-2026-10-19.md), [operations](OPERATIONS.md),
[roadmap](ROADMAP.md), [security disclosure](../SECURITY.md).
