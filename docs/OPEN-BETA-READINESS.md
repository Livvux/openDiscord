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
| Migration journal | Production has 40 rows, newest timestamp `1792407256144`; content/hash comparison still required | UNVERIFIED |
| Public probes/PWA | Collaborative Chromium browser: `/api/health` 200 `no-store`, `/api/ready` 200 `no-store`, `/manifest.webmanifest` 200 `application/manifest+json` | PASS |
| Candidate delivery | Work in `fix/open-beta-release-gates`; candidate checks, PR review, merge and production deployment recorded below when available | UNVERIFIED |

## P0 release gates

| ID | Gate and acceptance criterion | Current evidence / remaining action | Status |
| --- | --- | --- | --- |
| S1 | No unresolved Critical/High vulnerabilities; dependency, license, static and focused dynamic checks on release SHA | Baseline production audit: no known advisories; 130 declared production package licenses in 9 groups accepted. Internal source review is in progress. This does not replace a pentest. | UNVERIFIED |
| S2 | Auth/session/passkey/2FA, tenant authorization, CSRF, XSS, SSRF, uploads and rate limits reject abuse with regression evidence | Existing integration/browser suites and internal 2026-10-19 audit; revalidate exact candidate and dispositions. | UNVERIFIED |
| S3 | DM 1:1/groups/attachments/recovery/device revocation fail closed, no unintended plaintext fallback | Existing Matrix integration tests and historical browser evidence; current source review underway; independent crypto integration sign-off missing. | UNVERIFIED |
| S4 | Voice E2EE/SFU authorization/key revocation fail closed through reconnect and membership changes | Baseline Chromium/Firefox product acceptance green. Independent crypto integration sign-off, successful screen-share reception and hostile-network TURN acceptance missing. | UNVERIFIED |
| S5 | CSP exposure characterized and public encryption claims accurate | Production allows inline scripts. Nonces require dynamic rendering and are incompatible with the current PPR static shell per installed Next.js docs. Do not add a nonce header without changing/render-testing the shell. Public copy still understates implemented group/attachment/Voice E2EE. | FAIL claims; residual CSP risk |
| S6 | Independent crypto audit and external penetration test signed off | Owner must commission independent reviewers, fix findings and attach dated scope/revision/sign-off. Internal agent review is not independent cryptographic assurance. | UNVERIFIED, external |
| F1 | Registration, verification email, login/logout/recovery/passkeys/2FA work on supported browsers | Baseline CI and historical RC1; delivered verification/reset emails and physical browser flows still need actual evidence. | UNVERIFIED |
| F2 | Alpha→beta policy preserves pending/rejected states, anti-spam and admin controls | Existing isolated Closed Alpha suite; production policy must stay unchanged until explicit owner approval. Rehearse transition on disposable data only. | UNVERIFIED |
| F3 | Friends/profiles/communities/roles/invites/moderation; messages/attachments/reactions/threads/search/unread/notifications pass | Full Chromium desktop/Pixel 7 emulation baseline; additional cross-browser CI gate added in candidate, not yet executed. | UNVERIFIED candidate |
| F4 | Supported desktop browsers and mobile user journeys, accessibility/keyboard/screen-reader/loading/error/offline behavior accepted | RC1 contains real harness gaps and skipped mobile tests. New CI covers bounded Firefox/WebKit/Edge/iPhone-emulation journeys; emulation is not physical acceptance. | UNVERIFIED |
| F5 | Real iOS Safari and Android Chrome, PWA install/relaunch/recovery/storage, mobile encrypted DMs/groups/files/calls accepted | Physical devices unavailable to this run. Operator must record OS/browser/device versions, exact SHA, steps and results. | UNVERIFIED, physical devices |
| F6 | Real microphone/camera, successful screen-share publication/reception, reconnects and TURN/TLS through restrictive networks accepted | Existing denial and fake-device Opus/VP8 evidence is narrower. Requires two real endpoints and a controlled UDP-blocked network. | UNVERIFIED, operator/device/network |
| O1 | Backups remain viable at allowed beta storage capacity; safe limits enforced | Today's backup succeeds but 512 MiB media RAM budget and 1 GiB retained-full-bundle cap still allow accepted uploads to exceed recovery capacity. One 100 MB message × 31 dailies exceeds the cap. Warning-only #117 did not resolve this. | FAIL |
| O2 | Encrypted DB/media/config backup, retention, independent restore, restored app boot and media readback proven | 2026-10-21 backup 72,437 bytes, full encrypted readback hash; historical 2026-10-19 real DB/media restore. Current real-bundle app boot and restored-object reads remain missing. | UNVERIFIED |
| O3 | Production scanner active, signatures fresh, clean/EICAR and outage fail-closed proven | Scanner monitor healthy 2026-10-21; prior direct EICAR evidence and isolated real-engine CI. Current authenticated clean/EICAR upload evidence still required. Never stop production scanner as a test. | UNVERIFIED |
| O4 | Scheduled retention and Voice maintenance complete, independent health/backup/scanner/Voice alerts delivered | Hourly retention currently fails: missing `compose-index-virtual-microchip-f3zupk-migrate:latest`. No Voice maintenance/monitor timer observed. Backup/scanner healthy does not cover these failures. | FAIL |
| O5 | SMTP and Web Push actual delivery, storage, LiveKit/TURN and scheduled maintenance checked | Healthy HTTP and configured secrets cannot certify delivery. Actual inbox/push receipts, Voice repair scheduling and complete service acceptance missing. | UNVERIFIED |
| O6 | Realistic HTTP/SSE/DB/media characterization, enforced beta limits and rollback triggers | Synthetic read/HTTP/SSE CI workloads exist; not a production concurrency guarantee. No measured supported-user/media-bandwidth limit yet. Keep restricted Alpha. | UNVERIFIED |
| R1 | `main` rejects direct/force writes, needs review and successful checks | Applied/read back 2026-10-21: required `check`, `voice-product`, `real-engine` from GitHub Actions; strict up-to-date branch; 1 approval, last-push approval, stale approvals dismissed; admins included; force/deletion disabled; conversations resolved. Only Livvux currently has write rights, so a separate reviewer identity is required. | PASS protection; review prerequisite external |
| R2 | Exact release SHA passes all required checks and matches production/migrations/services | Baseline green is insufficient for changed candidate. No beta tag or release is published. | UNVERIFIED |
| R3 | Imprint/privacy/terms/age/guidelines/abuse/GDPR/support accurate and legally signed off | Public routes respond, but current legal approval is absent. Software text and an age checkbox are not counsel sign-off. | UNVERIFIED, external |
| R4 | Versioned release, changelog, support/security disclosure, deploy/rollback/incident smoke runbook ready | Existing SECURITY/OPERATIONS; candidate-specific runbook/changelog and post-deploy evidence still required. Unsigned desktop downloads must remain unpublished. | UNVERIFIED |

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
| New Firefox/WebKit/iPhone-emulation/Edge gate | UNVERIFIED | `playwright.beta.config.ts`: 80 collected tests in 13 files; collection is not execution. Some specs intentionally skip phones. WebKit blocks SW; Chromium PWA acceptance remains required. |
| Current public production in collaborative Chromium | PASS bounded | Home renders at 1280×800 without horizontal overflow; health/ready/manifest contracts pass. No authenticated or physical-device claim. |
| Real Safari, iOS Safari, Android Chrome, assistive technology | UNVERIFIED | Physical/real-device acceptance is outstanding |
| Real push, email inbox, hostile TURN, screen-share reception | UNVERIFIED | Separate service/device/network evidence required |

## Release ledger and operator handoff

PRs/merge commits and exact candidate checks will be appended after they exist. Branch protection
must not be bypassed to satisfy the delivery request. A self-review under the PR author's GitHub
identity cannot supply the required independent approval.

To change this decision to GO, close every P0 row with dated evidence on the final SHA, include
the external crypto/pentest/legal sign-offs and physical acceptance, prove the matching production
deployment/recovery, then obtain the owner's explicit approval for the admission-policy change.

References: [RC1 QA](QA-RC1-2026-10-20.md), [prior acceptance](ACCEPTANCE-2026-10-19.md),
[internal audit](SECURITY-AUDIT-2026-10-19.md), [operations](OPERATIONS.md),
[roadmap](ROADMAP.md), [security disclosure](../SECURITY.md).
