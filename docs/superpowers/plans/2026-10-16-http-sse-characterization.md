# Bounded authenticated HTTP/SSE characterization

Scope: characterize one actual production-build app process against isolated CI PostgreSQL.
This extends the service-only measurement; it is not production capacity, browser/media,
multiple replicas, automatic reconnect/replay, or a latency SLO.

- Use the supported Better Auth API to create 21 disposable users and signed session cookies.
  Twenty are community members, one is an outsider. Fixture setup is outside measurement.
- Seed 3,000 messages, open 20 distinct cookie-authenticated community SSE streams and wait
  for each `ready` event. Deny the outsider on actual HTTP history and SSE GET routes.
- Measure 100 history requests at concurrency 20 while streams remain open. Then send 16
  HTTP messages round-robin through four regular bot integrations and collect every message
  ID on all 20 streams. The existing five-message/five-second limit is untouched.
- Abort and await one stream, reconnect with its real cookie, and send one additional message.
  Require delivery on the reconnected stream and the other 19. No missed-message replay claim.
- Record nearest-rank latency distributions for HTTP reads/writes and fanout (write-start to
  receipt, including HTTP/DB processing), reconnect readiness and sentinel delivery, aggregate
  errors and host metadata. Do not mistake host RAM/CPU inventory for process resource usage.
- Bound HTTP operations, event waits, frame size and total duration. Abort and await every
  owned stream; require zero remaining fixture stream leases before deleting only scoped
  community/user/bot/rate-window fixtures; terminate the owned standalone server.
- CI runs this serially after the production build and before existing browser acceptance.
  Always upload sanitized aggregate JSON, including failure/cleanup status where possible.
  Never print cookies, passwords, bot tokens or synthetic account identifiers.

Focused framing/percentile tests run in the existing unit suite. Production source, limits,
authentication, storage, dependencies and Voice are unchanged. The implementation branch
requires exact-head remote CI plus an independent root review before any further delivery.
