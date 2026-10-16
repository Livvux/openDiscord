# Real attachment scanner acceptance

`.github/workflows/scanner-acceptance.yml` runs a separate disposable Ubuntu job.
It never uses production storage, credentials, database, Docker daemon or network.
The fixture requires GitHub Actions, an explicit acceptance flag, a localhost
database and its own private `/tmp/opendiscord-scanner-*` directory. ClamAV binds
only runner loopback. It has a 4 GiB memory limit, two CPUs and bounded readiness;
the app builds before the signature engine starts. The whole job has a 20 minute
deadline. The engine and private directory are removed even on test failure;
PostgreSQL is an ephemeral job service. Browser traces are disabled.

The official `clamav/clamav:stable` image resolved on 2026-10-16 to immutable index
`sha256:638d90201ee7ee6a82d249a2fc23b132e578673b5f1f2766852b127676ca1ef6`
(amd64 manifest `sha256:705e0723f02fc13bf6e5e8a8e13a8c44420acf5e7ed06dfa2197081da00c7a73`).
Docker Hub reported publication at 2026-10-12T01:47:32Z. This is the full image
with bundled official signatures. The documented `CLAMAV_NO_FRESHCLAMD=true`
setting prevents background updates; no empty database volume is mounted.
Pinned bundled databases make acceptance reproducible without downloading the
whole database through FreshClam on every PR. Updating this pin requires rerunning
acceptance and reviewing the captured engine/database metadata.

Acceptance records the actual clamd `VERSION` response (engine, signature version
and date), image digest, signature-file SHA-256 and `sigtool --info` metadata.
The artifact is evidence for that exact engine/database combination. Bundled
signature age is reported truthfully; it is not a claim of current production
coverage or a guarantee that every malicious file can be detected.

The test first sends harmless clean bytes and the standard harmless EICAR
antivirus test string to real clamd through INSTREAM. It then signs up through the
real browser, uploads/posts a clean file through the UI and exports the real
community archive. Authenticated HTTP import accepts that archive. A copy changes
only the attachment bytes, declared lengths and SHA-256 to EICAR, retaining valid
archive structure. Upload and import must return the scanner-specific rejection.
The job then stops only its own engine; clean upload/import must fail closed with
the scanner-unavailable response. Each rejected operation must leave attachment
rows, community IDs and every private file name/hash unchanged. The browser
checks the rendered clean attachment, captures a screenshot and checks page
errors. Dedicated users and rows are removed in test cleanup; the job removes
the entire private fixture and disposes the database even if test cleanup fails.

Production scanner deployment remains a separate operator decision: capacity,
private connectivity, supported engine version, FreshClam persistent database,
signature freshness/availability monitoring, backup and rollback must be reviewed
before enabling `CLAMAV_HOST`. This workflow does not install or configure a
production daemon or change the optional scanner behavior.

Official references:

- [ClamAV Docker images, memory requirements and daemon settings](https://docs.clamav.net/manual/Installing/Docker.html)
- [clamd protocol and VERSION](https://docs.clamav.net/manual/Usage/ClamdProtocol.html)
- [Docker Hub official image metadata](https://hub.docker.com/r/clamav/clamav)
- [EICAR harmless antivirus test file](https://www.eicar.org/download-anti-malware-testfile/)
