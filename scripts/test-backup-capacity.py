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
    def test_limits_match_previous_inline_checks(self):
        # Previously: size*4 > free or size > 512 MiB (database), size*3 (media), remote+bundle > 1 GiB.
        for free in (PLENTY, 1000 * MiB, 1000 * MiB + 3):
            for metric, copies in (("database", 4), ("media", 3)):
                limit = capacity.limit_for(metric, free)
                for size in (limit - 1, limit, limit + 1):
                    old = size * copies > free or size > 512 * MiB
                    self.assertEqual(capacity.record({}, metric, size, free)[1] is not None, old, (metric, free, size))
        self.assertIsNone(capacity.record({}, "encrypted_total", 1024 * MiB, 0)[1])
        self.assertEqual(capacity.record({}, "encrypted_total", 1024 * MiB + 1, 0)[1], "1 GiB encrypted backup budget reached")

    def test_advisory_metrics_never_fail_the_backup(self):
        for metric in ("dm_ciphertext", "retention_projection"):
            state, error = capacity.record({}, metric, 10 * 1024 * MiB, PLENTY)
            self.assertIsNone(error)
            self.assertFalse(state["metrics"][metric]["enforced"])

    def test_record_is_immutable_and_validated(self):
        original = {"at": "x", "metrics": {}}
        updated, _ = capacity.record(original, "media", 1, PLENTY)
        self.assertEqual(original["metrics"], {})
        self.assertEqual(updated["at"], "x")
        for metric, size in (("unknown", 1), ("media", -1)):
            with self.assertRaises(ValueError):
                capacity.record({}, metric, size, PLENTY)

    def test_cli_records_before_failing_closed(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(capacity.shutil, "disk_usage", return_value=type("U", (), {"free": PLENTY})):
            path = Path(directory) / "capacity.json"
            capacity.main(["x", str(path), "reset"])
            capacity.main(["x", str(path), "retention_projection", str(DM_MESSAGE)])
            with self.assertRaisesRegex(SystemExit, "Media exceeds"):
                capacity.main(["x", str(path), "media", str(512 * MiB + 1)])
            metrics = json.loads(path.read_text())["metrics"]
            self.assertEqual(metrics["media"], {"bytes": 512 * MiB + 1, "limit": 512 * MiB, "enforced": True})
            self.assertEqual(metrics["retention_projection"]["bytes"], 31 * DM_MESSAGE)


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
        self.assertIsNone(self.check(self.record(("database", 11 * MiB), ("media", 5 * MiB),
                                                 ("retention_projection", 31 * 8 * MiB), ("encrypted_total", 100 * MiB))))

    def test_one_large_dm_message_warns_long_before_the_aggregate_budget_fails(self):
        # ~100 MB bundles x 31 retained exceed 1 GiB within ~10 days; warn on the first day.
        record = self.record(("media", DM_MESSAGE), ("dm_ciphertext", DM_MESSAGE),
                             ("retention_projection", 31 * DM_MESSAGE), ("encrypted_total", DM_MESSAGE))
        self.assertEqual(self.check(record), "backup-capacity-warning")

    def test_eighty_percent_threshold(self):
        self.assertIsNone(self.check(self.record(("media", int(0.79 * 512 * MiB)))))
        self.assertEqual(self.check(self.record(("media", int(0.8 * 512 * MiB) + 1))), "backup-capacity-warning")

    def test_budget_failure_is_named(self):
        self.assertEqual(self.check(self.record(("media", 512 * MiB + 1)), job="exit-code"), "backup-capacity-exceeded")
        # An over-budget projection alone did not fail the job: other failures keep their own name.
        self.assertEqual(self.check(self.record(("retention_projection", 2048 * MiB)), job="exit-code"), "backup-job-failed")

    def test_missing_stale_or_invalid_record_fails_closed(self):
        stale = {**self.record(("media", 1)), "at": "2026-10-18T00:00:00Z"}
        for record in (None, stale, {"at": "2026-10-20T11:00:00Z", "metrics": {}},
                       {"at": "2026-10-20T11:00:00Z", "metrics": {"media": {"bytes": 1, "limit": 0, "enforced": True}}}):
            with self.subTest(record=record):
                self.assertEqual(self.check(record), "backup-capacity-unavailable")


if __name__ == "__main__":
    unittest.main()
