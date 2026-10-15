# Bounded service-load characterization

Scope: close the roadmap's missing measured-load evidence without asserting production capacity.
Use the existing isolated CI PostgreSQL database and actual permission-checked message service.
No dependency, migration, production data, local heavy workload or application behavior change.

1. Add a CI-only, explicit opt-in script with synthetic users/community and 3,000 messages.
2. Warm the service, then measure 100 latest-page reads at concurrency 20; validate every page and
   outsider denial. Record duration, throughput and latency percentiles with environment metadata.
3. Delete only this run's fixtures, close the pool, fail on incorrect results; bound the CI step.
4. Run in remote CI, upload the aggregate artifact, independently review the script and report
   measurements with limits: no HTTP, SSE, media, real users or production capacity claim.
