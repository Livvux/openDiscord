# Hosted beta stabilization — 2026-11-07

Follows [BETA-STABILIZATION-2026-11-01.md](BETA-STABILIZATION-2026-11-01.md). Scope unchanged: hosted
web application and installable PWA.

## Closed since November 1

- **Required checks run again.** The account billing lock is cleared. `check`, `voice-product` and
  `real-engine` executed on real runners for #164 and #168 and passed on their merged revisions.
- **Voice roster regression fixed (#168).** The first real `voice-product` run since October 24 failed:
  with three participants the first one saw only two. While a peer was still publishing keys,
  `CallSession.poll()` returned before reaching the server, so newer generations were only noticed by
  the 10 s heartbeat. Polling now refreshes the roster (at most every 2 s) while a remote member is
  waiting. Admission, SAS, consent and token gating are unchanged. Real users no longer see later joins
  up to 10 s late.
- **macOS video acceptance failures explained (#168).** Chromium on macOS decodes only key frames once
  receive-side encoded frames pass through a main-thread `TransformStream`; both the input and output
  hop reproduce it, while LiveKit's stock worker and the product path decode every frame (90/90). The
  worker proof now hands video receive streams straight to the worker as the product does, except for
  the tamper scenario. `voice-worker.spec.ts` passed 62/62 on macOS with two workers and two repeats.
  The product path was never affected: the three-account product spec decodes moving VP8 on macOS.
- **Stale UI selectors after the October redesign (#168).** The voice spec now leaves through the voice
  bar's *Disconnect*; the Linux native acceptance opens the settings section and the message actions
  menu the redesigned UI uses. Native Linux acceptance passed end to end again.
- **Security dependency update merged (#164):** Next.js 16.4.5 and Better Auth 1.7.16.

## Still open before a beta tag

1. Physical devices: iOS Safari and Android Chrome (also as installed PWA), real microphone/camera,
   received screen share, Web Push receipt, TURN on restrictive networks, screen readers.
2. External cryptographic integration review, authenticated penetration test and legal/privacy review
   of the frozen release revision ([external review packet](BETA-STABILIZATION-2026-11-01.md#external-review-packet)).
3. Agreed recovery-time/data-loss objectives and a full infrastructure recreation against them.
4. Immutable image deploy of the release revision with verified image label, migration hashes and
   authenticated browser journeys.
5. A fresh complete browser suite on the final revision. Flaky cases observed this week, all
   unrelated to the changes above and green on rerun: aborted Next.js RSC navigation requests logged as
   console errors in Firefox/WebKit (`voice-product` Firefox, `dm-tools` WebKit), a teardown race in
   `public-channels`, a duplicate message element in `search-jump`.
6. Dependency majors deferred until after the tag: Node 26 base image (#165) and
   `matrix-sdk-crypto-wasm` 19 (#167, belongs in the crypto review).

Registration being open does not close these gates.
