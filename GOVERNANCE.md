# Governance and licensing

openDiscord is maintained in the public [Livvux/openDiscord repository](https://github.com/Livvux/openDiscord).
The repository maintainer makes release and merge decisions. Contributors can propose changes through
issues and pull requests using [CONTRIBUTING.md](CONTRIBUTING.md). Significant architectural choices
are recorded in [docs/DECISIONS.md](docs/DECISIONS.md); roadmap changes and their acceptance evidence
are tracked in [docs/ROADMAP.md](docs/ROADMAP.md).

## Review and releases

Changes should explain the problem, resulting behavior and verification. Auth, permissions,
cryptography, data deletion and migrations require particular care. Passing CI and code review are
release gates; deployment and user acceptance are separate evidence. Maintainers may decline a
change that compromises privacy, self-hosting, maintainability or the project's stated scope.
Security reports follow [SECURITY.md](SECURITY.md), rather than public issues containing exploit details.

## Project and instance authority

A code maintainer's repository role does not grant moderation permissions in a community. Each
instance operator controls its deployment, and community permissions are enforced by the application.
Financial support grants no moderation powers or exclusive hosted capabilities. Hosted-instance
running costs and the operating funding goal are published at [opendiscord.app/funding](https://opendiscord.app/funding).

## License and independence

The core is licensed under [AGPL-3.0-only](LICENSE). Contributions are accepted under that license;
contributors retain their copyright. Dependency licenses remain their own, with the declaration gate
and review boundaries described in [docs/DEPENDENCY-LICENSES.md](docs/DEPENDENCY-LICENSES.md).
Operators can run the same application release on their own infrastructure. Changes to project
policy should be proposed and recorded in the repository so their rationale is reviewable.
