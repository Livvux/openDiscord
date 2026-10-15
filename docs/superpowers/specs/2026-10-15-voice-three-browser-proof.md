# Three-browser ephemeral voice control/media proof

2026-10-15. Design only until PR48 exact canonical CI and independent TypeScript review pass. Architecture/security conditional GO for readiness is recorded in the two readiness review reports. No production activation, deployment, schema, DM changes or new dependency is authorized by this proof.

## Objective and boundary

Show three independent real browser contexts using fresh memory-only Matrix SDK18.9.0 machines, all three genuine native SAS pairs and separate admission, then native Olm media-material/control delivery into unchanged LiveKit2.22.4 worker encryption. Demonstrate actual Opus and VP8 reception and the two distinct readiness orderings. Existing Node proof is a prerequisite, not this evidence.

Browser identity is a disposable call/member/user/device binding, unrelated to account/DM identities or persistent stores. Native verification requires the exact native sender/device plus isSenderVerified(), current call, exact recipient, admitted sender, epoch, publisher, keyId and immutable audience. Automation compares native SAS as a test oracle; no human-verification UX claim. All three publisher pairs must be verified and admitted before their controls may be sent. No setLocalTrust, import of identity secrets, direct cipher, shared fixture key or test-runner injection of plaintext media keys.

## Test-owned components and data boundaries

- Three separate Playwright browser contexts A/B/C. One serial native owner per page; no private machine or raw key returned by browser methods. Each page owns its own Room/provider/strict Worker and capture sources. Each publisher independently generates 32 bytes with browser crypto.getRandomValues; maintained createKeyMaterialFromBuffer produces its HKDF CryptoKey. Every remote copy must arrive in a verified native Olm control.
- Runner-owned bounded in-memory transport, isolated to one test call. Playwright exposeBinding source.page identifies the registered endpoint; request-supplied sender cannot select another owner. Allow only supported native public-key upload/query/claim/signature requests, bounded same-call SAS and targeted Olm envelopes. The runner sees public keys, native SAS protocol and ciphertext, never material/control plaintext. No HTTP/backend production route or real account credential is needed. Session authentication and hostile-server/group-consensus are outside this fixture's claim.
- Adapt the accepted native proof semantics without importing its Node-only crypto/Buffer or same-process owner objects into the browser. Browser owner uses global crypto/TextEncoder and the browser WASM export. Transport accepts bounded plain request descriptors and returns exact public SDK response shapes. It owns public bindings/keys/mailboxes only. Native methods and private keys stay in the individual context.
- One fixture-specific observing subclass of existing StrictVoiceWorker records actual outbound identity/index/key-object mapping, ordered SDK enable commands and native ACKs. Forward original commands/transferables unchanged; preserve strict downgrade, unknown-identity and premature-transform refusal. No private Room manager, fake SDK event or manually authored enable command.
- Use the existing doubly gated Next proof surface. A separate child route under /voice-worker-proof can reuse the existing proxy prefix gate; its server page must independently check GITHUB_ACTIONS=true AND OPENDISCORD_VOICE_PROOF=1 before dynamic client import. Default404, CSP and native worker bytes unchanged. No static media keys or server credentials in fixture bundles. Verify all three partial/off gate combinations on the production build.

## Bounded authenticated application controls

A single versioned strict schema carries kind material|prepared|key-ready with transaction UUID, call/epoch UUID, exact sender/recipient bindings, publisher binding, keyId UUID, sorted unique audience bindings and receipt reference. Audience max3 in this proof. Material alone contains canonical base64 encoding of exactly32 random bytes. Prepared/key-ready contain no material; they reference the accepted material transaction/keyId and locally remembered exact audience. Reject unexpected fields, wrong binding/epoch, duplicates and missing current references before updating readiness.

Native encryptionInfo, raw sender and payload sender must all agree. Key-ready's sender is the receiving device, recipient is the publisher. Publishers track one receipt per current admitted receiver for their own key; local readiness is separate. No unsigned runner command can populate a receipt or verified-material map. Runner orchestration may request actions/hold delivery but cannot directly set readiness true.

Limits: 128KiB serialized native request, max3 target users and1 device each, bounded key upload (100prekeys), mailbox64, total transport submissions1024, processed control64 per owner per epoch, bounded drain loops (8rounds) and serial operations. Material and receipt collections are dropped on epoch close. Native request retries have exact type/body digest receipts; changed body under a receipt key is rejected. One-time prekeys use claim tombstones. Unknown native output fails before transport delivery. All cleanup runs in finally.

## Required state ordering

1. Verified/admitted native material is validated and imported in memory. Optional prepared receipt reports only this state. Publication remains forbidden.
2. Freeze expected publisher→keyId/CryptoKey mapping and audience. Construct a fresh epoch-specific provider/Room/Worker, prepopulate every expected publisher key at index0, autoSubscribe=false, use public setE2EEEnabled(true) and connect.
3. Observe each actual outbound setKey with exact identity, index0 and expected CryptoKey object. Require native supported HKDF key algorithm/usages. Observe these posts before SDK's own-local enable on this fresh worker. Its matching positive ACK is a queue-order fence. Earlier ACKs, foreign identities, other worker generations and missing posts cannot count.
4. Only after that fence and no observed failure send native Olm key-ready controls to the relevant publishers. Publisher requires its local current fence plus exact current authenticated key-ready from every admitted receiver before any capture publication.
5. Actual TrackPublished triggers SDK remote enable. Validate current admitted publisher and encrypted GCM publication/expected codec, wait the exact positive remote ACK on this worker, then public setSubscribed(true). Strict worker separately refuses early decode/encode setup. Track attachment follows subscription. Record both readiness orderings; do not equate them.

The native queue releases even after a rejected task; a later positive enable ACK is NOT per-key installation success. Unhandled native queue rejection may not trigger Worker.onerror. Do not invent an ACK or patch the native queue. Correct supported HKDF inputs plus positive decoded-media evidence and fresh-worker missing/wrong-key negatives establish the narrower tested boundary. onSetEncryptionKey callbacks and Room.isE2EEEnabled do not prove remote key success.

Epoch/key/audience change invalidates every receipt and requires fresh workers/providers/Rooms. Old asynchronous callbacks check owner generation before any state write or subscribe. Observed error/messageerror/native crypto error/close/timeout stops source tracks, attached tracks and worker synchronously, invalidates readiness, then disconnects. No plaintext or indefinite retry fallback.

## Acceptance matrix

| Case | Required evidence |
| --- | --- |
| Browser native identity/SAS | Three separate contexts and machines; distinct public fingerprints; all3 genuine SAS pairs completed with retained native handles and six directed verified-device checks; admission separate |
| Before C verification/admission | A/B controls work; attempted delivery to C rejected before submit, C receives no material, C cannot release publication |
| Positive all3 Opus and VP8 | Every browser publishes independent material and synthetic media, receives both other publishers; six directed authenticated material/key-ready deliveries; every remote stream has increasing inbound bytes plus Opus samples/energy or VP8 framesDecoded/width, actual codec correct |
| Readiness causality | Actual all expected setKey posts→own local enable command→matching ACK→authenticated current receipts→publish; actual remote publication validation→remote ACK→subscribe/decode. No secret values in trace |
| Prepared only | Hold genuine key-ready delivery after valid material/prepared; publisher publications and encode setups remain0; releasing valid receipts completes positive media |
| Missing expected key | Omit one expected provider entry in fresh receiver; mapping check refuses fence and emits no key-ready; corresponding publisher stays unpublished. Separate native missing-key decoder case described below |
| Wrong key native drop | After positive baseline, fresh diagnostic media instance uses a valid independent wrong HKDF key; unchanged native decoder receives encrypted frames but decoded useful audio/video stays0, with no fallback. No receipt/publication-release override |
| Native missing-key drop | Fresh diagnostic worker/receiver has no key for actual encrypted publisher; SDK remote enable alone is insufficient; incoming encrypted frames yield zero decoded useful media. This diagnostic intentionally does not run the normal release protocol and cannot be reported as an admitted call |
| Stale epoch/worker | Normal previously generated prepared/key-ready controls and late callbacks do not release next epoch or change its readiness; no manually fabricated native messages |
| Ordinary leave/rekey | On observed C leave, stop old A/B media, fresh A/B epoch/workers/new publisher material delivered only to A/B; A/B resume. C receives no new material. A separate explicitly diagnostic stale-key receiver may prove old retained key cannot decode the fresh publication; never report it as current admission |
| Teardown/failure | Native failure or close invalidates receipt state, stops transforms/capture; no increasing native output after bounded buffer drain; all synthetic rooms/contexts/workers/AudioContexts/canvas intervals disposed |
| Next production delivery | Actual workers from same-origin /_next/static assets, fetched SHA256 equals installed original SDK worker bytes; actual browser worker URLs match; WASM loaded in each context; no product fixture at default404 |

For missing/wrong-key native diagnostic tests, instantiate the same unchanged native worker and normal public SDK receiver path with autoSubscribe=false. The diagnostic directly exercises decoder behavior, rather than allowing a known-invalid setup to obtain key-ready or bypass the normal release gate. Keep this separation explicit in methods, test labels and reports; reuse existing accepted native-media negative harness where possible, while new three-browser gate tests prove missing receipt blocks publication. Do not weaken normal expected-key enforcement to make a negative test run.

Every nonempty emitted synthetic source frame is transformed, with existing documented native fixed SIF/DTX/blank exceptions preserved; no claim every native accepted byte is authenticated. Assert actual createEncodedStreams use and ScriptTransform=false. Capture per-stream evidence keyed by exact publisher/track/media; aggregate counts alone cannot let one sender mask another. Every negative establishes a normal positive baseline or reuses the exact native artifact whose positive baseline passed in the same suite.

## Verification and reporting

Remote canonical lint/typecheck/unit/integration/build/E2E and Docker only. Three browser contexts under both existing Chromium desktop/mobile profiles; no physical-device/Safari/ScriptTransform conclusion. Use per-phase bounded assertions rather than increasing global timeouts to hide a deadlock. Real SFU fixture required; no mocked media acceptance. No key/token/SDP dumping, no secret screenshots. Safe summary contains counts, event order, public identities, generation IDs, codecs, bytes/energy/frame counters and worker asset hash.

No broad voice product integration until exact-head runtime results and independent TypeScript/security review. Supported failures stop for review, not a private API/manual native command workaround. Production authentication, DB mailboxes, leases, account revocation, reconnect authority, human SAS UI and deployment are later product gates.

Sources: installed SDK declarations/source and current official references verified on2026-10-15: https://matrix-org.github.io/matrix-sdk-crypto-wasm/classes/OlmMachine.html ; https://github.com/livekit/client-sdk-js/blob/v2.22.4/src/e2ee/E2eeManager.ts ; https://github.com/livekit/client-sdk-js/blob/v2.22.4/src/e2ee/worker/e2ee.worker.ts . Existing PR40 and PR48 fixtures are concrete local integration references, not substitutes for three-browser runtime acceptance.
