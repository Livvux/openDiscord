# Community assets implementation plan

Spec: ../specs/2026-10-15-community-assets.md. Root owns this worktree; no other agent edits it. No new dependency or lockfile change planned. Read installed Next route/usePathname docs before routing work, installed Drizzle/Sharp types and existing implementations before library calls. Heavy checks remote only.

- [x] Review concrete design, especially atomic sweeper claims and portability versioning. Independent SQL design review requires linkedAt/assetId predicates and Community → Attachment lock ordering.
- [x] Add schema/migration and shared token/projection tests; preserve Unicode behavior.
- [x] Add bounded private library upload/read/delete with existing image/scanner/storage/quota paths and concurrent permission/cap tests.
- [x] Integrate send/edit/reaction validation, batched DTOs, renderer, composer/picker and manager controls; cover desktop/mobile and accessible fallback behavior.
- [x] Extend JSON/archive versions with legacy readers, whole-library export, staging/atomic remapping and personal export/privacy projections.
- [ ] Run exact remote canonical checks and real browser flows; resolve independent SQL/security/TS findings.
- [ ] Merge/deploy only after final exact-head CI; verify revision/readiness/private delivery and record actual limits/remaining external acceptance.

Implementation evidence: static library API/UI, message/reaction integration, JSON v2/archive v3 and personal export v7 are implemented. Independent SQL/storage review and code review findings were resolved; the separate security review required exact-Origin checks for POST/DELETE, now implemented before authentication/body reads with route regressions. Real PostgreSQL/filesystem tests cover concurrent names/caps, foreign-community send/edit/react/read, suspension/membership loss, uploader ownership, community cleanup, permanent sweep claim/retry, complete unused-library fresh-ID remapping, legacy fallback and atomic staged rollback. Desktop/mobile E2E exercises manager upload, member picker/render/reaction, archive remapping and deletion fallback. Runtime evidence is tracked against the exact pushed head; no deployment or production acceptance is claimed by this implementation step.
