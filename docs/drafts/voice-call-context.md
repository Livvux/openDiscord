# S6-A1 authenticated call context — UNREACHABLE / Draft

This dependent slice integrates accepted PR62 (`f22df5d`), three-browser proof parent
(`4386e07`) and native-generation proof PR57 (`f0ac454`) over the S5 HTTP transport
candidate. Those individual proofs do not replace final integrated CI or S5 approval.
Migrations0030–0032 remain isolated-CI only; production has0000–0029.

Before implementing the reviewed Owner extension, the first test measures full
`JSON.stringify(VoiceCryptoRequest)` UTF-8 bytes, including native and transport IDs,
after genuine public-SDK Olm encryption. Eight complete current parties appear in
each payload; two real native endpoints complete SAS. Generated UUID account IDs
and maximum128-ASCII account IDs are separate cases. This is payload feasibility,
not eight admitted owners, browser authentication, service acceptance or media proof.
The existing8192-byte ceiling remains unchanged. A failed feasibility test blocks
the full repeated-party wire representation until an independently reviewed compact
representation is agreed.

Planned scope is strict context-offer/accept/restart over the existing Olm event,
Owner-issued two-phase staging capabilities, exact locally selected admitted audience,
leader-wide sequence and explicit local consent, all-peer authenticated acceptance,
and bounded pending slots. No UI, CallSession HTTP changes, capture, worker, SFU,
schema, deployment, production or media activation belongs to this slice.

Existing low-level `setControlContext` is retained only for S3/S4 primitive regression
fixtures. It provides no in-band agreement or readiness certificate. The later narrow
product Owner interface must omit it; activation requires a source/callsite check.
