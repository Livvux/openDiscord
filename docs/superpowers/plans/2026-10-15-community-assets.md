# Community assets implementation plan

Spec: ../specs/2026-10-15-community-assets.md. Root owns this worktree; no other agent edits it. No new dependency or lockfile change planned. Read installed Next route/usePathname docs before routing work, installed Drizzle/Sharp types and existing implementations before library calls. Heavy checks remote only.

- [x] Review concrete design, especially atomic sweeper claims and portability versioning. Independent SQL design review requires linkedAt/assetId predicates and Community → Attachment lock ordering.
- [ ] Add schema/migration and shared token/projection tests; preserve Unicode behavior.
- [ ] Add bounded private library upload/read/delete with existing image/scanner/storage/quota paths and concurrent permission/cap tests.
- [ ] Integrate send/edit/reaction validation, batched DTOs, renderer, composer/picker and manager controls; cover desktop/mobile and accessible fallback behavior.
- [ ] Extend JSON/archive versions with legacy readers, whole-library export, staging/atomic remapping and personal export/privacy projections.
- [ ] Run exact remote canonical checks and real browser flows; resolve independent SQL/security/TS findings.
- [ ] Merge/deploy only after final exact-head CI; verify revision/readiness/private delivery and record actual limits/remaining external acceptance.
