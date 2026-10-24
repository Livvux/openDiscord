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

MiB = 1024 * 1024
GiB = 1024 * MiB
MEMORY_BUDGET = 512 * MiB
# Owner-approved Open Beta capacity (2026-10-22): 50 GiB stored media, enforced at upload by
# MEDIA_STORAGE_LIMIT_BYTES, and an 80 GiB encrypted restic repository for 30 daily snapshots.
MEDIA_BUDGET = 50 * GiB
REPOSITORY_BUDGET = 80 * GiB
# The plaintext media mirror shares the root disk with PostgreSQL; never let it eat this reserve.
DISK_RESERVE = 20 * GiB
MIRROR = Path("/var/lib/opendiscord-backup/media")
# metric -> (fixed limit, enforced)
METRICS = {
    "database": (MEMORY_BUDGET, True),
    "media": (MEDIA_BUDGET, True),
    # E2EE DM ciphertext is part of media (incompressible, up to 4 x 25 MB per message); shown separately.
    "dm_ciphertext": (MEDIA_BUDGET, False),
    "repository": (REPOSITORY_BUDGET, True),
}
MESSAGES = {
    "database": "Database exceeds safe in-memory backup budget",
    "media": "Media exceeds approved or disk-safe backup budget",
    "repository": "80 GiB encrypted backup repository budget reached",
}


def limit_for(metric: str, room: int | None) -> int:
    """`room` is what the host can hold for this metric right now (None: no local constraint)."""
    fixed = METRICS[metric][0]
    return fixed if room is None else max(0, min(fixed, room))


def record(state: dict, metric: str, size: int, room: int | None) -> tuple[dict, str | None]:
    """Return the updated record and the fail-closed error, if this measurement exceeds an enforced budget."""
    if metric not in METRICS or size < 0:
        raise ValueError("Invalid capacity measurement")
    limit = limit_for(metric, room)
    enforced = METRICS[metric][1]
    updated = {**state, "metrics": {**state.get("metrics", {}), metric: {"bytes": size, "limit": limit, "enforced": enforced}}}
    return updated, MESSAGES[metric] if enforced and size > limit else None


def tree_bytes(path: Path) -> int:
    return sum(entry.stat().st_size for entry in path.rglob("*") if entry.is_file()) if path.exists() else 0


def room_for(metric: str) -> int | None:
    if metric == "database":
        # Dump, restore listing and attachment extract can coexist in /dev/shm.
        return shutil.disk_usage("/dev/shm").free // 4
    if metric == "media":
        # Already mirrored bytes are reused; only growth needs free disk beyond the reserve.
        return shutil.disk_usage(MIRROR if MIRROR.exists() else MIRROR.parent).free + tree_bytes(MIRROR) - DISK_RESERVE
    return None


def main(argv: list[str]) -> None:
    path = Path(argv[1])
    if argv[2:] == ["reset"]:
        state = {"at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "metrics": {}}
        error = None
    else:
        metric, size = argv[2], int(argv[3])
        state, error = record(json.loads(path.read_text()), metric, size, room_for(metric))
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state))
    temporary.replace(path)
    if error:
        raise SystemExit(error)


if __name__ == "__main__":
    main(sys.argv)
