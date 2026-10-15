# Dependency license inventory policy

CI runs `node scripts/check-dependency-licenses.mjs` after the frozen install. It reads the app's
production graph through the installed pnpm command, rejects missing/empty metadata and fails on a
license expression outside the reviewed inventory. Run `pnpm --dir apps/web licenses list --prod --json`
for package/version details. The workspace root has no app dependencies and may produce an empty
inventory; it must not be used for this check.

Current accepted declarations are MIT, MIT-0, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD,
`(Apache-2.0 AND BSD-3-Clause)`, CC-BY-4.0 and MPL-2.0. In particular caniuse-lite declares
CC-BY-4.0 and web-push declares MPL-2.0: the old roadmap statement that every runtime dependency is
MIT/Apache/ISC/BSD was incomplete. Preserve the upstream copyright/license notices when distributing
artifacts. File-level copyleft and data attribution obligations are not discharged by this allowlist.

This automated gate inventories package declarations. It is not a legal compatibility opinion,
an SBOM attestation, a source-code license audit or proof that all distribution obligations have been
met. A new declaration needs an explicit review of its actual package contents and intended use;
never add an exception solely to make CI green.
