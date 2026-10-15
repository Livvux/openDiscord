# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **"Report a vulnerability"** button on this
repository (Security → Advisories). Do not open public issues for security problems.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports
within 3 working days and to agree on a disclosure date with you; the default is 90 days or the
release of a fix, whichever comes first. We credit reporters who want to be credited.

## Scope

In scope: this repository's code and the default deployment (`docker-compose.yml`, `Caddyfile`).
Out of scope: denial of service through traffic volume, social engineering, and findings that need a
compromised operator machine.

## Supported versions

Only the latest release receives security fixes during early development.

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for the threat model and known residual risks.
