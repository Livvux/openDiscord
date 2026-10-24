"""Backup budget bookkeeping: fail-closed limits, early-warning record and monitor interpretation."""
import datetime as dt
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capacity = load("capacity", "backup-capacity.py")
monitor = load("monitor", "operator-monitor.py")
MiB = 1024 * 1024
DM_MESSAGE = 4 * 25 * MiB  # largest E2EE DM message: four 25 MB ciphertext attachments
PLENTY = 64 * 1024 * MiB


class BudgetTests(unittest.TestCase):
    def test_database_is_bounded_by_ram_and_shared_tmpfs(self):
        for room in (None, 100 * MiB):
            limit = capacity.limit_for("database", room)
            self.assertEqual(limit, 512 * MiB if room is None else 100 * MiB)
            self.assertIsNone(capacity.record({}, "database", limit, room)[1])
            self.assertEqual(capacity.record({}, "database", limit + 1, room)[1], "Database exceeds safe in-memory backup budget")

    def test_media_is_bounded_by_approved_capacity_and_disk_reserve(self):
        self.assertEqual(capacity.limit_for("media", PLENTY), capacity.MEDIA_BUDGET)
        self.assertEqual(capacity.limit_for("media", 3 * capacity.GiB), 3 * capacity.GiB)
        self.assertEqual(capacity.limit_for("media", -1), 0)
        self.assertIsNotNone(capacity.record({}, "media", 50 * capacity.GiB + 1, PLENTY)[1])
        self.assertIsNone(capacity.record({}, "repository", 80 * capacity.GiB, None)[1])
        self.assertEqual(capacity.record({}, "repository", 80 * capacity.GiB + 1, None)[1], "80 GiB encrypted backup repository budget reached")

    def test_room_counts_existing_mirror_and_keeps_disk_reserve(self):
        with tempfile.TemporaryDirectory() as directory:
            mirror = Path(directory) / "media"
            (mirror / "attachments").mkdir(parents=True)
            (mirror / "attachments" / "a.bin").write_bytes(b"x" * 1000)
            usage = type("U", (), {"free": capacity.DISK_RESERVE + 5 * capacity.GiB})
            with patch.object(capacity, "MIRROR", mirror), patch.object(capacity.shutil, "disk_usage", return_value=usage):
                self.assertEqual(capacity.room_for("media"), 5 * capacity.GiB + 1000)
                self.assertIsNone(capacity.room_for("repository"))

    def test_advisory_metric_never_fails_the_backup(self):
        state, error = capacity.record({}, "dm_ciphertext", 100 * capacity.GiB, PLENTY)
        self.assertIsNone(error)
        self.assertFalse(state["metrics"]["dm_ciphertext"]["enforced"])

    def test_record_is_immutable_and_validated(self):
        original = {"at": "x", "metrics": {}}
        updated, _ = capacity.record(original, "media", 1, PLENTY)
        self.assertEqual(original["metrics"], {})
        self.assertEqual(updated["at"], "x")
        for metric, size in (("unknown", 1), ("media", -1), ("retention_projection", 1)):
            with self.assertRaises(ValueError):
                capacity.record({}, metric, size, PLENTY)

    def test_cli_records_before_failing_closed(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(capacity, "room_for", return_value=PLENTY):
            path = Path(directory) / "capacity.json"
            capacity.main(["x", str(path), "reset"])
            capacity.main(["x", str(path), "dm_ciphertext", str(DM_MESSAGE)])
            with self.assertRaisesRegex(SystemExit, "Media exceeds"):
                capacity.main(["x", str(path), "media", str(capacity.MEDIA_BUDGET + 1)])
            metrics = json.loads(path.read_text())["metrics"]
            self.assertEqual(metrics["media"], {"bytes": capacity.MEDIA_BUDGET + 1, "limit": capacity.MEDIA_BUDGET, "enforced": True})
            self.assertEqual(metrics["dm_ciphertext"]["bytes"], DM_MESSAGE)


class MonitorCapacityTests(unittest.TestCase):
    now = dt.datetime(2026, 10, 20, 12, tzinfo=dt.UTC).timestamp()

    def check(self, record, job="success"):
        files = {"last-success": "2026-10-20T11:00:00Z daily/x.age", "capacity.json": json.dumps(record)}

        def read_text(path, *_args, **_kwargs):
            if path.name not in files or files[path.name] is None:
                raise FileNotFoundError(path)
            return files[path.name]
        if record is None:
            files["capacity.json"] = None
        with patch.object(Path, "read_text", read_text), \
                patch.object(monitor.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, job)), \
                patch.object(monitor, "maintenance_job_problem", return_value=None):
            return monitor.check({"mode": "backup"}, self.now)

    def record(self, *measurements):
        state = {"at": "2026-10-20T11:00:00Z", "metrics": {}}
        for metric, size in measurements:
            state, _ = capacity.record(state, metric, size, PLENTY)
        return state

    def test_small_instance_is_healthy(self):
        self.assertIsNone(self.check(self.record(("database", 11 * MiB), ("media", 5 * MiB), ("repository", 100 * MiB))))

    def test_large_dm_messages_no_longer_exhaust_the_budget(self):
        # Incremental snapshots store a 100 MB message once, not once per retained daily bundle.
        record = self.record(("media", 10 * DM_MESSAGE), ("dm_ciphertext", 10 * DM_MESSAGE), ("repository", 11 * DM_MESSAGE))
        self.assertIsNone(self.check(record))

    def test_eighty_percent_threshold(self):
        GiB = capacity.GiB
        self.assertIsNone(self.check(self.record(("media", 39 * GiB))))
        self.assertEqual(self.check(self.record(("media", 40 * GiB + 1))), "backup-capacity-warning")
        self.assertEqual(self.check(self.record(("repository", 65 * GiB))), "backup-capacity-warning")

    def test_budget_failure_is_named(self):
        self.assertEqual(self.check(self.record(("repository", 80 * capacity.GiB + 1)), job="exit-code"), "backup-capacity-exceeded")
        # An over-budget advisory metric alone did not fail the job: other failures keep their own name.
        self.assertEqual(self.check(self.record(("dm_ciphertext", 60 * capacity.GiB)), job="exit-code"), "backup-job-failed")

    def test_missing_stale_or_invalid_record_fails_closed(self):
        stale = {**self.record(("media", 1)), "at": "2026-10-18T00:00:00Z"}
        for record in (None, stale, {"at": "2026-10-20T11:00:00Z", "metrics": {}},
                       {"at": "2026-10-20T11:00:00Z", "metrics": {"media": {"bytes": 1, "limit": 0, "enforced": True}}}):
            with self.subTest(record=record):
                self.assertEqual(self.check(record), "backup-capacity-unavailable")


if __name__ == "__main__":
    unittest.main()
