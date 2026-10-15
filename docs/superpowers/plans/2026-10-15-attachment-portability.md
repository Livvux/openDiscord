# Attachment portability implementation plan

The roadmap-completion authorization covers this increment. Root owns the separate feat/portable-attachments worktree; the DM implementer owns its existing branch. Preserve legacy JSON behavior and existing private storage/permission boundaries.

- [ ] Review the design and fix concrete admission, cancellation, quota and cleanup gaps.
- [ ] Add bounded gzip/NDJSON codec regressions before implementation: fragmented records, corruption/truncation, compressed/decompressed/record limits and cancellation.
- [ ] Implement batched owner-only export with all included attachment bytes and explicit limits; avoid large SQL IN lists and unbounded object buffering.
- [ ] Stage validated/scanned/re-encoded imports privately, preserve quotas, and atomically link staged objects in the existing community-import transaction. Cover foreign identifiers and failed cleanup.
- [ ] Expose the complete archive beside legacy JSON, support upload/import in the existing dialog and clearly describe limits and imported attribution.
- [ ] Run remote lint/types/tests/build/Docker and real desktop/mobile browser download/import/private-delivery checks; complete independent code/security review.
- [ ] Commit/push, exact-head release, production readback and evidence ledger. Do not claim operational backups are replaced by a community archive.

API verification: installed Next16.4 route-handler/streaming docs and Node22 stream documentation read before implementation; Docker uses Node22. Native Node zlib/stream types are the fallback where remote zlib docs were unavailable. No new dependencies or lockfile changes planned.
