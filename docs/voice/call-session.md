# Unactivated CallSession and installed media consumer

`CallSession.create` requires deliberate Voice join consent, a real authenticated account/session assertion and an existing read-only DM enrollment anchor. It acquires its own account Web Lock and creates independent memory-only Voice enrollment secret/device/nonce. Native WASM is dynamically imported only after browser join. No storage writes, DM initializer, provider, UI or legacy issuer changes occur. The browser media module is dynamically imported only after genuine all-peer context installation.

Before any receive/user SAS processing, `keysPrepared` must confirm a completed public full-roster query for the exact current generation. Completed native factory bootstrap proves own published public device keys only; it does not rewrite own join snapshot state. Every remote must be `active` in the authoritative roster: the existing service sets this only after valid immutable device/prekey publication, independently of SAS/trust/admission. A waiting remote blocks receive/query for the full-roster call until the normal ten-second heartbeat observes same-generation waiting-to-active. Then one bounded query prepares the native device cache; one-second polls never repeatedly query. A real generation transition clears this barrier synchronously. Query is outside transition/drain, singleflight by generation, and stale completion cannot prepare a new generation after exact binding/lease checks. This deliberately delays all roster SAS while any remote has not published keys; no readiness-discovery wire kind or extra bootstrap heartbeat is added. Initial self-only polling still produces a genuine HTTP409 first when a second participant joins.

`confirmFullRoster` is separate explicit roster consent. Every other exact party first needs genuine native SAS and separate `admit`; selection never admits. The sole native Owner also owns the sole private agreement ledger. The frozen product port exposes agreement methods and bound query/flush/SAS/admit/transition, omitting primitive receive/context setters and raw native access. Context controls use the strict public schema; offer transactions equal the shared proposal reference.

Timers own whole receive batches, never overlap and wait at least one second after completion. Capabilities are processed before the next receive; pending material stays only in Owner. Thin local-consent-pending results carry no proposal/ref/authority and never create a retry. Explicit fresh full-roster selection creates one new attempt/revision. Its conservative ten-second deadline begins before queued selection/staging/fanout work, never per recipient. An expired selection stops context polling until explicit retry; local readiness was already required before selection. Heartbeats and lease checks continue. No automatic selection/re-enrollment/retry occurs.

All issued HTTP requests, including join, native crypto sync/ACK/flush, heartbeat, discovery and best-effort leave, enter one rolling sixty-second counter. Total cap is 180; ordinary work stops at 162, reserving eighteen slots for heartbeat/discovery/leave and leaving sixty of the server's shared 240 slots for other activity. Before negotiation the adapter requires an additional conservative `8 + 8 * remoteCount` ordinary slots (minimum eight). This is an admission policy, not an eight-party throughput claim. Actual tests assert traces remain within the cap without bypassing service rate limits. 429 and unknown current native failures end the call. Optional negotiation can report insufficient budget without starting an attempt.

The thirty-second maximum lease starts at the HTTP request start and uses the server lease duration; delayed responses cannot gain time. Late older-generation/older-request grants cannot extend newer authority. Visibility/pageshow and all control boundaries check monotonic expiry/account/session. Cleanup synchronously aborts/fences, closes Owner once, releases guard, and attempts one bounded leave; server lease/reaper remains authoritative.

The first typed normal HTTP409 fences synchronously, shares only authoritative heartbeat discovery, requires a genuinely newer exact own enrollment, and invokes one external Owner transition before returning the original error. The transition target/active flag is set synchronously. Old captured-binding responses may wait on its bounded driver; target-generation successful retirement requests deliver immediately to avoid a self-cycle. Any409 during transition or installation drain ends immediately as `VoiceRetirementConflict`, without discovery/nesting. Same-generation conflict is fatal. Continuing churn is bounded call failure, not transparent retained-owner availability.

`fenceRevision` increments synchronously at HTTP/native fences and teardown. Selection/stage/install callbacks synchronously expose `negotiating`, generation callbacks expose `waiting`, and fatal callbacks expose `ended`. These callbacks preserve a legitimate current attempt/ref during stage/install; only authoritative generation/HTTP fencing invalidates that attempt. `agreed` is exposed only after actual Owner all-peer completion, installation and the earlier local deadline check. Render observers cannot change native lifetime through thrown callbacks.

Received replacement offers are staged prospectively: the installed attempt/ref/view/timer remain unchanged until the actual Owner stage succeeds. Only the actual typed `VoiceContextRejected` at that stage boundary can reject a lower/retired replay nonfatally. Rejected proposal context/pending refs expire at the next Owner batch; independent installed-current media still reaches the explicit media boundary. Successful stage synchronously fences through Owner, then captured attempt/revision/lease/earlier receive-start deadline are rechecked before committing the replacement. Divergent-equal, schema/native, acceptance and transport failures remain fatal.

The private installed media consumer receives the exact proposal audience, sequence and immutable installed snapshot, with closure capabilities for current-context checks, authenticated native sends and the real service token. It never receives the Owner, agreement ref, enrollment secret, raw HTTP client or native machine. Installation drains authenticated retained material into the captured instance exactly once. Startup does not wait for future peer material inside the native receive batch. `agreed` still describes cryptographic context agreement, not media readiness.

Each full-roster party, including listeners, generates independent 32-byte participant key material. Nonextractable HKDF imports precede authenticated prepared receipts. A fresh public participant-specific BaseKeyProvider, StrictVoiceWorker and Room contain every exact roster identity at key index zero. Every actual SDK setKey submission must match the expected CryptoKey and identity before a genuine positive own enable ACK permits key-ready. Publication additionally requires key-ready from every other admitted receiver. Prepared alone never permits capture. The ten-second media keying deadline begins at actual Owner installation before dynamic import/token work, is bounded by the remaining call lease and never resets per peer or response.

Own source grants come only from the actual service token and control local intent methods. No permitted source is captured automatically. `setMicrophoneEnabled`, `setCameraEnabled` and `setScreenShareEnabled` require current full readiness and the exact own source grant. Video forces VP8 in the third publish-options argument. Screen audio is refused; screen capture explicitly uses audio:false. Empty listener sources mean zero local source/capture/publication calls, while full-roster key import, genuine own ACK, key-ready and remote decode remain required.

Remote auto-subscription is disabled. Every publication checks current admitted identity, source/kind, Opus/VP8 and exact GCM, then waits for a genuine matching remote worker ACK before subscribing and checks current context again before attach. Own empty sources never imply remote source denial. **Pinned SDK metadata exception:** LiveKit 2.22.4 exposes only an isEncrypted public getter accepting any non-NONE enum. This slice reads only the declared `publication.trackInfo.encryption` signaling value after public metadata checks to enforce exact GCM. No protected-field cast, private manager access or metadata write is used. Missing/unknown/non-GCM fails closed; SDK upgrades require this source and actual worker/browser gate to be reviewed again.

JWT expiry bounds connection use immediately before and after connect; it does not establish SFU revocation. Established media follows the latest authoritative CallSession lease. Reconnecting, SignalReconnecting (including signal-only resume), disconnect, worker error, context/generation/session change and close synchronously fence sources/playback/worker before asynchronous disconnect. Automatic SDK reconnect cannot restore old keys/tokens. Delayed capture results are stopped. A fresh context creates a fresh Room/key table/worker/token; no old-epoch readiness is reused.

The controlled Chromium gate bundles only test static modules/worker/WASM with the existing locked Vite API and serves a finite static URL list through Playwright. Existing authenticated HTML and all cookie HTTP/native/service traffic remain real, without a proof route, window epoch coordinator, test JWT or private SDK manager. Transparent native Worker/RTCPeerConnection observation forwards genuine messages/streams and stores aggregate evidence only. Controlled non-silent oscillator and moving canvas capture produce real Opus/VP8 over the SFU. This authored gate is not acceptance until exact-head CI executes it successfully; three-account product UI and physical-device/mobile/screen-audio acceptance remain later.

Tests distinguish adapter races with a mocked public port from actual public native Owners, authenticated cookies, HTTP route and PostgreSQL service. The three-Owner asynchronous consent test compares real public SAS, continues genuine mailbox ACK/SAS after early local-not-ready, explicitly retries full selection and reaches independent all-peer barriers. Test-only observation of genuine public factory return values enables an actual encrypted material consumer-delivery assertion. These Node tests mock only media effects to retain their control scope; they make no real ACK/media claim. This is control/native/service evidence, not authenticated product-browser, media, device, deployment or production acceptance.

## Product presentation and acceptance

The app shell now resolves authenticated account/session IDs under its own Suspense
boundary and keys one VoiceProvider by that exact identity. The provider observes the
official auth client session state, fences before sign-out or encryption-identity reset,
and closes on unmount. Navigation only detaches video elements; the provider audio root
and authenticated CallSession survive text-channel navigation.

Joining requires separate consent to a temporary Voice device and existing encrypted
messaging setup. Voice never enrolls a messaging device. Each exact full-roster peer must
complete genuine native SDK SAS comparison on both browsers, then be separately admitted.
Full-audience consent is another explicit action.

The protocol steps that carry no trust decision run automatically once keys are prepared
(`voice-verification.ts`): the lower member ID requests, the peer accepts, the requester
starts SAS and the peer accepts SAS. Each step is attempted once per generation; after a
failure the matching manual button remains. Comparing the symbols ("they match"),
admitting, cancelling and full-audience consent stay explicit clicks. Admission is not
merged into the match confirmation: the Voice Olm proof spec defines admission as a
separate, deliberate publisher choice after native verification (you can verify who a
device is and still decline to send it your media keys), so per pair a person now clicks
"they match" and "admit" instead of six buttons. Reusing DM verification for Voice stays a
follow-up: the same spec says DM verification never substitutes for Voice SAS, and carrying
trust over would need the DM identity to sign each temporary Voice device, which the
current integration does not do. The UI displays native `Sas.emoji()`
symbols and descriptions from pinned Matrix crypto SDK18.9.0; no local emoji table or
trust conversion is involved. Generation changes clear current media and require full
roster consent again. Microphone, camera and screen sharing remain off until explicit
source clicks. Screen capture requests video only.

Statuses name the phase in plain words (connecting, waiting for others, comparing symbols,
agreeing the audience, preparing media, ready) and an ended call states why (connection
interrupted, could not reach the voice server, keying timed out, permission lost, signed
out). After a failure a "Rejoin" button creates a fresh temporary device and call. SDK
reconnects stay terminal, so old keys are never restored; a user rejoin starts from zero.
Capture errors distinguish blocked permission, missing device, busy device and a
cancelled screen picker.

### Browser support

Media encryption runs in livekit-client's unchanged E2EE worker through either Chromium's
encoded streams (`createEncodedStreams`) or standard `RTCRtpScriptTransform` (Firefox,
Safari); `support.ts` accepts either and nothing else, with no plaintext fallback.
setKey/enable and the positive own ACK pass through `StrictVoiceWorker` on both paths. On
the script-transform path the SDK attaches transforms via `new RTCRtpScriptTransform(worker)`,
which bypasses `postMessage`, so the worker's early encode/decode and codec checks cannot
observe it; MediaSession's ordering (publish only after own ACK plus every key-ready,
subscribe only after the publisher's ACK and exact-GCM/Opus/VP8 checks) is the enforcing
layer there. Product acceptance runs in Chromium and Firefox. Playwright WebKit reached
decoded Opus and moving VP8 locally but is not in CI (unrelated DM-client page errors);
real Safari, Edge and mobile browsers are untested.

CallView exposes immutable, key-free media state and opaque playback tile IDs. It does
not expose Room, Track, tokens or key material. `agreed` alone is never displayed as media
ready. MediaSession validates current subscriptions and owns attach/detach operations;
fences synchronously clear all presentation and stop captures. Exact own token source
grants control local actions, while a listen-only peer can still decrypt admitted media.

`Voice product acceptance` is a separate disposable hosted job. It builds the actual
Next production server and starts LiveKit1.13.10 with `room.auto_create: false`. Its
three separate authenticated accounts use real product signup, community membership,
messaging setup, Voice consent, three native SAS pair comparisons (protocol steps automatic,
symbol confirmation clicked), six admissions and three full-audience decisions. The job runs
the spec in Chromium, then again in Firefox (`VOICE_PRODUCT_BROWSER=firefox`). Native Worker/RTCPeerConnection observers forward original
operations unchanged and retain only counts/order/stats. The test checks worker fetch
content type/CSP, own positive SDK ACK after all exact key submissions, listen-only empty
source grants, non-silent decoded Opus, changing VP8 pixels in actual product video
mounts, navigation remounts, responsive layout, capture toggles, renewed calls past the
original join JWT expiry, and Connect revocation. SAS values, keys, tokens and identities
are excluded from the diagnostic summary; comparison traces are disabled.

These are test requirements, not a claim that the current revision has passed them.
The exact hosted check IDs and outcomes belong in the implementation report. Existing
control/lifecycle/media suites retain lower-layer negative coverage; they do not substitute
for the actual Next product gate. Physical audio devices, WebKit/Safari encrypted media,
eight-browser capacity, arbitrary networks and external cryptographic audit remain outside
this acceptance. Source CI never enables production: operator freeze, migration, exact SFU
configuration, cleanup and independent review remain release prerequisites.

## Direct-message calls

A call has exactly one context: a community voice channel or a direct-message conversation
(`voice_call.channel_id` xor `voice_call.conversation_id`, migration 0039, one active call per
context). Everything below the authorization check is the same code path: the same temporary
Voice device, native SAS comparison, separate admission, full-audience consent, generation-room
keys, StrictVoiceWorker, no plaintext fallback, heartbeat lease and SFU reconciliation. Channel
calls keep their checks unchanged (Join voice/Speak/Video, community lock).

**Authorization.** A person may join, heartbeat, exchange native control traffic and receive a
media token for a conversation call exactly while they may send a message there now
(`conversationFor(..., sending)`): an accepted 1:1 conversation with no block in either
direction and an active (not suspended or unapproved) peer, or a current group member (not left,
not removed) whose own account is active. As for every call, the caller's own session, anchor
device and account must be valid, and no two live participants of the call may have a block in
either direction. Every participant gets microphone, camera and screen grants (screen audio is
still refused by the client). Strangers and removed members get `not_found`; pending requests,
blocked pairs and suspended accounts get `forbidden`.

**Revocation.** The check is repeated on every join, heartbeat (ten seconds), control request,
token grant and SFU reconciliation, all under the Voice lifecycle lock. Leaving or being removed
from a group ends that person's call membership in the same transaction that changes the group
(the group change now takes the Voice lock first). A block ends every call both people are in.
Suspension, revoked sessions and anchor revocation end calls as they do for channels. Ending a
membership advances the generation, so the remaining people move to a fresh room and fresh media
keys the removed device never receives; the removed browser's next heartbeat or token request is
refused and its old generation room is retired and deleted by the SFU reconciler. A 1:1 call ends
for both people when either side blocks, or when the peer is suspended (the same rule as sending).

**Room names and metadata.** The SFU room name is `voice:<callId>:<callId>:<generation>` for
direct-message calls (the room-scope segment is the call's own random ID), so LiveKit never sees
a conversation ID. The application server sees which conversation has a call, who joined and when,
like channel calls.

**Ringing.** Starting a conversation call (the first join) sends a content-free `call` event on the
personal event stream to every other current member who has no block with the caller: caller and
conversation only. A Web Push says "Incoming call" with the caller's name (skipped for Do not
disturb and blocks; at most one per caller and conversation every 30 seconds). A call holds at most
eight devices, so in a group of up to ten people the ninth device's join is refused. When the call closes, members receive an `ended` event; a ring that was not
answered becomes a missed call, as does a ring older than 45 seconds. Accepting a ring is the
explicit Voice join consent (the ring card states what joining creates). Declining is local only:
the caller is not told. Missed calls are shown in this browser until dismissed; they are not stored
on the server, and answering on one device does not clear the ring on the person's other devices.
The provider keeps one active call per browser: accepting or starting a call leaves any other call.

Integration coverage: `tests/voice-dm-calls.integration.test.ts` (members, strangers, pending,
blocks, group removal and leaving, suspension, ringing and block-filtered rings, maintenance
sweep); `tests/dm-call-ring.test.ts` (ring/missed state); `e2e/dm-calls.spec.ts` in the Voice
product job, Chromium and Firefox (missed call, accept from the ring, SAS and admission, decoded
Opus and VP8, a block ending the call).
