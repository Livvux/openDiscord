"""Focused alert-state regression checks; no network or credentials."""
import datetime as dt
import http.client
import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("monitor", Path(__file__).with_name("operator-monitor.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class AlertStateTests(unittest.TestCase):
    def test_broken_http_response_enters_failure_state(self):
        with patch.object(monitor.urllib.request, "urlopen", side_effect=http.client.IncompleteRead(b"")):
            self.assertEqual(monitor.check({"mode": "health"}, 100), "public-health-unavailable")

    def test_backup_probe_failures_enter_failure_state(self):
        now = dt.datetime(2026, 10, 15, tzinfo=dt.UTC).timestamp()
        for error in (subprocess.TimeoutExpired("systemctl", 10), OSError("unavailable")):
            with patch.object(Path, "read_text", return_value="2026-10-15T00:00:00Z daily/backup.age"), \
                    patch.object(monitor.subprocess, "run", side_effect=error):
                self.assertEqual(monitor.check({"mode": "backup"}, now), "backup-status-unavailable")

    def test_transient_and_alternating_failures(self):
        state = {}
        for code in ("health-down", "ready-down"):
            state, notification = monitor.transition(state, code, 100, 3)
            self.assertIsNone(notification)
        state, notification = monitor.transition(state, "health-down", 100, 3)
        self.assertEqual(notification, "Failure: health-down")
        self.assertEqual(state["failures"], 3)

    def test_repeat_alerts_are_bounded_across_failure_codes(self):
        state = {"problem": "health-down", "failures": 3, "notified_problem": "health-down", "sent_at": 100}
        _, notification = monitor.transition(state, "ready-down", 101, 3)
        self.assertIsNone(notification)
        _, notification = monitor.transition(state, "ready-down", 3700, 3)
        self.assertIsNotNone(notification)

    def test_recovery_remains_retryable_until_delivery(self):
        state = {"problem": "down", "failures": 3, "notified_problem": "down", "sent_at": 100}
        updated, notification = monitor.transition(state, None, 200, 3)
        self.assertEqual(notification, "Recovered")
        self.assertEqual(updated["notified_problem"], "down")
        self.assertEqual(monitor.transition(updated, None, 201, 3)[1], "Recovered")

    def test_transient_recovery_needs_no_email(self):
        state, _ = monitor.transition({}, "down", 100, 3)
        state, notification = monitor.transition(state, None, 101, 3)
        self.assertIsNone(notification)
        self.assertEqual(state, {"problem": None, "failures": 0})


if __name__ == "__main__":
    unittest.main()
