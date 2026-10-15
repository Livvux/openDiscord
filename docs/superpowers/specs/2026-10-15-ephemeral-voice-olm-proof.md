# Disposable voice OlmMachine feasibility proof

Status: isolated proof; no product activation or release approval. This replaces the previous shared-DM-machine design for voice control. The existing DM singleton, persistent store, transport, consent rules and application UI are out of scope and must remain unchanged.

## Decision and supported boundary

Use installed `@matrix-org/matrix-sdk-crypto-wasm`18.9.0 public APIs: `OlmMachine.initialize(user, device, undefined, undefined, logger)` creates a memory-only store. Each call member gets a fresh voice-only Matrix user namespace and random device identity. No DM key, store name, recovery bundle, history or trust is imported. Native cross-signing is bootstrapped independently inside that disposable identity. Gossip setters are false, but they are not described as an inner-event sandbox.

Native SAS must freshly verify the exact voice peer/device/flow. The proof compares native decimal SAS on two fixture endpoints, explicitly confirms both, then checks native device verification. Automated comparison demonstrates SDK mechanics only; a future UI must require people to compare over an independently trusted channel. Existing DM verification never substitutes for voice SAS. Admission is a separate explicit, in-memory publisher choice after native verification.

The disposable machine may process native state changes. Isolation comes from independent native stores/keypairs and restricted transport ownership, not filtering after `receiveSyncChanges`. This proof uses normal valid native requests and application control messages. It does not resume the stopped adversarial native-import investigation, develop exfiltration probes or claim comprehensive hostile-inner-event containment.

## Small executable scope

- Test-only memory transport registered with fixture-owned exact call/member/user/device bindings. There are no HTTP routes, database tables, migrations or real account/session credentials.
- Strict outgoing allowlist: own native key upload and cross-signing bootstrap; same-call known-device key query/atomic prekey claim; bounded native SAS request/ready/start/accept/key/mac/done/cancel; targeted verified application Olm control; signatures for actual registered device/master keys. Reject room sends, backups, unknown requests, wildcard recipients and foreign namespaces before submitting/marking sent. Re-check every later outgoing batch.
- Bound request body, destinations, mailbox and drain rounds. Use SDK request objects and `markRequestAsSent` responses, not custom ciphertext or private fields. Close on owner failure or leave; dropping the transport loses its public directory/mailbox too.
- Three independent voice devices A/B/C. A/B starts unverified; genuine SAS makes them verified without local-trust override. C is not admitted implicitly. Verify/admit C independently before ordinary encrypted controls are delivered to it. Unadmitted send is denied by application ownership without constructing attack payloads.
- A separate DM baseline machine creates and decrypts ordinary valid local history. Capture its public fingerprints, room-key counts, pending request identities and native verification status before/after voice bootstrap/SAS/control/close. They must remain unchanged, and the baseline history must still decrypt. This does not import or instrument a user's real DM store.
- Reopen a voice member with the same textual fixture IDs but no store name: new identity keys, no prior native trust/history/session state. Application admission belongs only to the old owner and is not transferred. This proves supported memory-store disposal semantics, not browser RAM zeroization.

## Sequencing and later gates

First prove native ephemeral identities/SAS/control/state independence under canonical remote CI. Then extend the accepted strict LiveKit Worker/browser harness to three actual devices using only verified/admitted control deliveries, independent media epochs and native acknowledgements. Do not infer this integration from three Node machines alone. The latter remains a separate gate if not implemented in this increment.

Before broad product code: independent security/TypeScript review of this scoped proof and a revised product contract must cover real account/device/session enrollment, exact namespace authority, own transport tables/receipts, cross-call authorization, Web Lock/serial owner, leases/revocation, independent audience ACKs/rekey/removal, teardown fencing, reconnects and UI consent. The old shared-machine dispatcher/extraction/prekey-sharing steps are superseded. No live E2EE label until those gates pass.

Other limits: honest delivered JavaScript, no key transparency/group consensus, no independent audit, no physical-device/Safari claim. Existing strict-media proof covers only Chromium createEncodedStreams/Opus/VP8 and native fixed silence/blank-frame exceptions. No custom cipher, signed binding protocol or trust shortcut is introduced.

Primary API: https://matrix-org.github.io/matrix-sdk-crypto-wasm/classes/OlmMachine.html . Exact installed declarations for initialize, Device.encryptToDeviceEvent, receiveSyncChanges, DecryptedToDeviceEvent and native SAS are authoritative for this pinned proof.
