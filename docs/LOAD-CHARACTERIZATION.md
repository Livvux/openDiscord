# Service-load characterization

The CI step **Characterize isolated message read load** uses a disposable PostgreSQL database,
20 synthetic member identities and 3,000 messages. After five warm-up reads, it performs 100
latest-page reads at concurrency 20 through the actual `listMessages` service, including current
membership/permission checks and message DTO joins. Every response must contain 50 scoped messages;
a non-member must be denied. The script removes only its own generated fixtures and closes the pool.

The `load-characterization` artifact records total duration, throughput and p50/p95/p99/max
end-to-end service latency, plus Node/CPU-count/memory metadata. These describe one small synthetic
CI workload, not stable performance promises. Runner contention, PostgreSQL cache state and the
shared connection pool affect results. No arbitrary timing threshold makes CI green or red;
incorrect results and failed operations fail the run.

This excludes HTTP/session middleware, SSE fan-out, active writes, search, large attachments,
voice/video, browser rendering and production network/storage behavior. It does not establish a
supported concurrent-user count or justify virtualizing message history. Profile those workloads
in a representative isolated deployment before making capacity or client-rendering decisions.

The script refuses to run unless GitHub Actions and explicit `OPENDISCORD_ISOLATED_LOAD=1` are set,
and `DATABASE_URL` targets the CI database `opendiscord` on loopback. Do not point the CI database at
production or tunnel production onto its loopback port. Run it only as the bounded workflow step;
no production benchmark endpoint is exposed.
