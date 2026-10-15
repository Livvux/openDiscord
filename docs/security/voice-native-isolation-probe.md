# Native voice isolation prerequisite (nonactivating)

Pinned SDK: `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0. This experiment changes no product machine, routing, server authorization, or voice feature.

## Experiment

Use isolated in-memory native WASM machines and a fixture-only key query/claim exchange. Establish real Olm sessions, encrypt adversarial native inner events with the public Device API, and feed the envelopes through receiveSyncChanges. Explicitly disable and read back both room-key forwarding and requests. Evaluate Untrusted and CrossSigned decryption settings separately. Record only event types, fixture aliases, result classes and counters; never serialize native bodies in test failures.

Inspect every direct receive return and four subsequent outgoing rounds without sending or marking any generated request. Lack of a request in these rounds is bounded observation, not proof that future work cannot enqueue one. An application discard after receive cannot undo an imported room session. Check imported state with a real encrypted timeline event and strict native trust requirements, preserving existing DM sender/device/conversation gates.

## Acceptance / stop

The first phase characterizes native room-key import and unsupported application scope wrappers. It must not be presented as complete shared-machine isolation. Full acceptance additionally requires verified malicious peers, same-account secret requests, forwarded keys, request/cancellation handling, cross-scope SAS continuation, pending-request owner restart, and explicit DM share/history regressions under the proposed production settings. Existing manual history tests remain unchanged.

Any native import despite application scope rejection is an architecture review counterexample to post-decrypt state isolation. A passing characterization test records the behavior; it is not product GO. No second product machine, private API or custom decryptor is permitted. Canonical remote CI supplies execution evidence; no local test/build/browser runs.

## Observed remote evidence

At head `45c533e`, GitHub Actions run `38802162379` completed the initial seven native probes: six passed; the CrossSigned room-key test failed because its assumption of zero imports was false. An unverified peer's real native room-key envelope increased the receiver's room-key count by one under **both** Untrusted and CrossSigned, with both gossip settings explicitly false. The test expectation is corrected to preserve that counterexample. This is evidence of native state import before application filtering; it is not evidence that DM sender/device/conversation authorization was bypassed, nor evidence of network key exfiltration. The strict timeline-decryption assertion must still pass on the corrected head.

Verified-peer scope continuation, opaque own-secret output, manual DM delivery/history and owner detach checks are additional remote experiments. They are not claimed successful before their exact-head CI runs finish. In-memory native fixtures cannot establish persistent IndexedDB restart behavior; that remains a browser/owner acceptance prerequisite if the shared-machine design continues.
