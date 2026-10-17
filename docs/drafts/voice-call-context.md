# S6-A1 authenticated call context — UNREACHABLE / Draft

This dependent slice integrates accepted PR62 (`f22df5d`), three-browser proof parent
(`4386e07`) and native-generation proof PR57 (`f0ac454`) over the S5 HTTP transport
candidate. Those individual proofs do not replace final integrated CI or S5 approval.
Migrations0031–0033 remain isolated-CI only; production has0000–0029.

Before implementing the reviewed Owner extension, the first test measures full
`JSON.stringify(VoiceCryptoRequest)` UTF-8 bytes, including native and transport IDs,
after genuine public-SDK Olm encryption. Eight complete current parties appear in
each payload; two real native endpoints complete SAS. Generated UUID account IDs
and maximum128-ASCII account IDs are separate cases. This is payload feasibility,
not eight admitted owners, browser authentication, service acceptance or media proof.
The existing 8192-byte ceiling remains unchanged. A failed feasibility test blocks
the full repeated-party wire representation until an independently reviewed compact
representation is agreed.

The first actual remote run (38828457954, head b030801) established that the repeated
full-party representation fails all eight cases: UUID context 8625/material 8753;
maximum128-ASCII context 9969/material10097 bytes. These are actual encrypted full
request sizes, not estimates or compile failures.

The first correction was `encoding:"party-table-v1"`: retain the complete sorted
audience table once in each encrypted application payload and reference sender,
recipient and leader/publisher by member UUID. Decode into complete canonical
bindings before the unchanged strict installed-context/native envelope checks.
Unknown encoding, malformed compact fields, duplicates, sorting and unknown
references fail without retrying legacy parsing. Legacy full canonical controls
are explicitly selected by absence of the encoding discriminator and still undergo
the strict canonical Owner validator. Outgoing Owner material uses the codec before
SDK encryption. Context Owner agreement remains unimplemented and unreachable.

The new remote run also measures normal maximum UTF-8 account IDs. Better Auth's
current default generates32ASCII alphanumeric IDs, but the actual SQL user primary
key is unconstrained text and the Voice contracts allow128Unicode code units; this
does not establish an ASCII-only invariant for every accepted existing account.

The route integration test mocks only SFU SDK ports while retaining real auth,
PostgreSQL, native HTTP and JWT verification. The browser E2E instead performs
native bootstrap in the Node test process through that disposable browser's real
cookie APIRequestContext, receives a real token and checks exact-room CreateRoom
with real CI LiveKit `listRooms([canonicalRoom])`. It does not establish a browser
native Owner or product media acceptance.

Actual v1 run38830263670 checked synthetic merge of066fa6d into d6568af: UUID
contexts7281/material7387 fit, but128ASCII8262/8369,128BMP10971/11078 and
128JSONescaped15025/15153 do not. All74other test files passed; no full CI acceptance
followed because tests blocked later build/browser stages.

The reviewed v2 correction replaces each party object with a strict tuple
`[memberUUID,accountIdBase64UTF16BE,voiceDeviceUUID,joinNonceUUID]`. Exact voiceUserId
and participantIdentity derive only from call/member and the fixed Voice domain;
encoder rejects any nonmatching full canonical field. Account IDs encode exact JS
UTF16 code units in fixed big-endian order,2–256bytes, canonical strict base64,
no normalization. Full UUIDs remain in the table. Sender/recipient/leader/publisher
are strict integer indices0–7, checked against actual table length, resolving to
the same exact canonical parties. No new cryptography or native body rewriting.
Unpublished v1 is removed; malformed/unknown encodings never retry canonical legacy.
V2 is pending actual sixteen native measurements, full CI and independent review;
the earlier sizes are not v2 acceptance evidence.

Planned scope is strict context-offer/accept/restart over the existing Olm event,
Owner-issued two-phase staging capabilities, exact locally selected admitted audience,
leader-wide sequence and explicit local consent, all-peer authenticated acceptance,
and bounded pending slots. No UI, CallSession HTTP changes, capture, worker, SFU,
schema, deployment, production or media activation belongs to this slice.

Existing low-level `setControlContext` is retained only for S3/S4 primitive regression
fixtures. It provides no in-band agreement or readiness certificate. The later narrow
product Owner interface must omit it; activation requires a source/callsite check.
