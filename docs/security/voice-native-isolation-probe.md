# Native voice isolation prerequisite (nonactivating)

Pinned SDK: `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0. This experiment changes no product machine, routing, server authorization, or voice feature.

## Experiment

Use isolated in-memory native WASM machines and a fixture-only key query/claim exchange. Establish real Olm sessions, encrypt adversarial native inner events with the public Device API, and feed the envelopes through receiveSyncChanges. Explicitly disable and read back both room-key forwarding and requests. Evaluate Untrusted and CrossSigned decryption settings separately. Record only event types, fixture aliases, result classes and counters; never serialize native bodies in test failures.

Inspect every direct receive return and four subsequent outgoing rounds without sending or marking any generated request. Lack of a request in these rounds is bounded observation, not proof that future work cannot enqueue one. An application discard after receive cannot undo an imported room session. Check imported state with a real encrypted timeline event and strict native trust requirements, preserving existing DM sender/device/conversation gates.

## Acceptance / stop

The first phase characterizes native room-key import and unsupported application scope wrappers. It must not be presented as complete shared-machine isolation. Full acceptance additionally requires verified malicious peers, same-account secret requests, forwarded keys, request/cancellation handling, cross-scope SAS continuation, pending-request owner restart, and explicit DM share/history regressions under the proposed production settings. Existing manual history tests remain unchanged.

Any native import despite application scope rejection is an architecture review counterexample to post-decrypt state isolation. A passing characterization test records the behavior; it is not product GO. No second product machine, private API or custom decryptor is permitted. Canonical remote CI supplies execution evidence; no local test/build/browser runs.
