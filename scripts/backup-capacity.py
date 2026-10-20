"""Backup capacity budgets: record every measurement for the operator monitor, then fail closed.

  backup-capacity.py STATE_FILE reset
  backup-capacity.py STATE_FILE METRIC BYTES

The record holds byte counts and limits only, never user content.
"""
import datetime as dt
import json
import shutil
import sys
from pathlib import Path

MEMORY_BUDGET = 512 * 1024 * 1024
ENCRYPTED_BUDGET = 1024 * 1024 * 1024
# Daily bundles are kept 30 days; one extra covers lifecycle-expiry lag.
RETAINED_BUNDLES = 31
# metric -> (/dev/shm copies held at once or None, fixed limit, enforced)
METRICS = {
    "database": (4, MEMORY_BUDGET, True),
    "media": (3, MEMORY_BUDGET, True),
    # E2EE DM ciphertext is part of media (incompressible, up to 4 x 25 MB per message); shown separately.
    "dm_ciphertext": (3, MEMORY_BUDGET, False),
    "encrypted_total": (None, ENCRYPTED_BUDGET, True),
    # Steady state of the aggregate budget if every retained bundle were this size: an early warning only.
    "retention_projection": (None, ENCRYPTED_BUDGET, False),
}
MESSAGES = {
    "database": "Database exceeds safe in-memory backup budget",
    "media": "Media exceeds safe in-memory backup budget",
    "encrypted_total": "1 GiB encrypted backup budget reached",
}


def limit_for(metric: str, shm_free: int) -> int:
    copies, fixed, _ = METRICS[metric]
    return fixed if copies is None else min(fixed, shm_free // copies)


def record(state: dict, metric: str, size: int, shm_free: int) -> tuple[dict, str | None]:
    """Return the updated record and the fail-closed error, if this measurement exceeds an enforced budget."""
    if metric not in METRICS or size < 0:
        raise ValueError("Invalid capacity measurement")
    limit = limit_for(metric, shm_free)
    updated = {**state, "metrics": {**state.get("metrics", {}), metric: {"bytes": size, "limit": limit, "enforced": METRICS[metric][2]}}}
    return updated, MESSAGES[metric] if METRICS[metric][2] and size > limit else None


def main(argv: list[str]) -> None:
    path = Path(argv[1])
    if argv[2:] == ["reset"]:
        state = {"at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "metrics": {}}
        error = None
    else:
        metric, size = argv[2], int(argv[3])
        if metric == "retention_projection":
            size *= RETAINED_BUNDLES
        state, error = record(json.loads(path.read_text()), metric, size, shutil.disk_usage("/dev/shm").free)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state))
    temporary.replace(path)
    if error:
        raise SystemExit(error)


if __name__ == "__main__":
    main(sys.argv)
