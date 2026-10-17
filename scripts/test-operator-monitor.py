"""Focused alert-state regression checks; no network or credentials."""
import datetime as dt
import http.client
import importlib.util
import json
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

    def test_voice_status_thresholds_and_recovery(self):
        healthy = {"finished_at": 1000, "ok": True, "limited_streak": 0, "sdk_failure_streak": 0}
        cases = [(healthy, None), ({**healthy, "finished_at": 879}, "voice-invocations-stale"),
                 ({**healthy, "finished_at": 1031}, "voice-invocations-stale"),
                 ({**healthy, "ok": False}, "voice-job-failed"),
                 ({**healthy, "limited_streak": 5}, None),
                 ({**healthy, "limited_streak": 6}, "voice-scheduling-pressure-sustained"),
                 ({**healthy, "sdk_failure_streak": 6, "ok": False}, "voice-sdk-failures-sustained")]
        for status, expected in cases:
            with self.subTest(status=status), patch.object(Path, "read_text", return_value=json.dumps(status)), \
                    patch.object(monitor.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "success")):
                self.assertEqual(monitor.check({"mode": "voice"}, 1000), expected)

    def test_voice_missing_status_and_failed_unit(self):
        with patch.object(Path, "read_text", side_effect=FileNotFoundError):
            self.assertEqual(monitor.check({"mode": "voice"}, 1000), "voice-status-unavailable")
        status = {"finished_at": 1000, "ok": True, "limited_streak": 0, "sdk_failure_streak": 0}
        with patch.object(Path, "read_text", return_value=json.dumps(status)), \
                patch.object(monitor.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "timeout")):
            self.assertEqual(monitor.check({"mode": "voice"}, 1000), "voice-job-failed")

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


class ScannerTests(unittest.TestCase):
    now = dt.datetime(2026, 10, 16, 12, tzinfo=dt.UTC).timestamp()
    config = {"mode": "scanner", "web_project": "app-project", "web_service": "web",
              "scanner_project": "scanner-project", "private_network": "app-private"}
    version = "ClamAV 1.5.4/28155/Fri Oct 16 11:00:00 2026"

    def facts(self):
        return {"State": {"Running": True, "OOMKilled": False, "Health": {"Status": "healthy"}},
                "Config": {"Image": monitor.SCANNER_IMAGE, "Env": ["TZ=Etc/UTC"]},
                "HostConfig": {"Memory": 4294967296, "MemorySwap": 4294967296, "PortBindings": {},
                               "LogConfig": {"Type": "json-file", "Config": {"max-size": "10m", "max-file": "3"}}},
                "Mounts": [{"Type": "volume", "Destination": "/var/lib/clamav", "RW": True}],
                "NetworkSettings": {"Networks": {"app-private": {"Aliases": [monitor.SCANNER_ALIAS]}, "scanner-egress": {}}}}

    def run_check(self, facts=None, version=None, top=None, error=None, web_networks=None, discovery=None):
        facts = facts or self.facts()
        def run(arguments, **kwargs):
            self.assertLessEqual(kwargs["timeout"], 10)
            if error:
                raise error
            if arguments[1] == "ps":
                return subprocess.CompletedProcess(arguments, 0, discovery if discovery is not None else "a" * 12)
            if arguments[1] == "inspect":
                data = facts if arguments[-1] == "{{json .}}" else (web_networks if web_networks is not None else {"app-private": {}})
                return subprocess.CompletedProcess(arguments, 0, json.dumps(data))
            if arguments[1] == "network":
                return subprocess.CompletedProcess(arguments, 0, json.dumps({"Internal": False, "Driver": "bridge", "Labels": {
                    "com.docker.compose.project": "scanner-project", "com.docker.compose.network": "default"}}))
            if arguments[1] == "top":
                return subprocess.CompletedProcess(arguments, 0, top if top is not None else "COMMAND\nfreshclam --checks=12 --daemon --foreground --stdout --user=clamav\n")
            self.assertEqual(arguments[1:3], ["exec", "a" * 12])
            return subprocess.CompletedProcess(arguments, 0, json.dumps({"version": version or self.version}))
        with patch.object(monitor.subprocess, "run", side_effect=run):
            return monitor.check(self.config, self.now)

    def test_healthy_private_probe_and_failure_boundaries(self):
        self.assertIsNone(self.run_check())
        for discovery in ("", "a" * 12 + "\n" + "b" * 12):
            self.assertEqual(self.run_check(discovery=discovery), "scanner-unavailable")
        for error in (PermissionError(), subprocess.TimeoutExpired("docker", 10)):
            self.assertEqual(self.run_check(error=error), "scanner-unavailable")
        self.assertEqual(self.run_check(top="COMMAND\ntail -f /dev/null\n"), "scanner-update-process-missing")
        self.assertEqual(self.run_check(web_networks={}), "scanner-config-mismatch")

    def test_container_and_configuration_drift(self):
        for key, value in (("Running", False), ("OOMKilled", True), ("Health", {"Status": "unhealthy"})):
            facts = self.facts()
            facts["State"][key] = value
            self.assertEqual(self.run_check(facts=facts), "scanner-container-unhealthy")
        for key, value in (("Memory", 0), ("MemorySwap", -1), ("Privileged", True),
                           ("PortBindings", {"3310/tcp": [{"HostPort": "3310"}]}), ("LogConfig", {})):
            facts = self.facts()
            facts["HostConfig"][key] = value
            self.assertEqual(self.run_check(facts=facts), "scanner-config-mismatch")
        for change in ("image", "timezone", "network", "alias", "mount"):
            facts = self.facts()
            if change == "image": facts["Config"]["Image"] = "clamav/clamav:latest"
            if change == "timezone": facts["Config"]["Env"] = ["TZ=Europe/Berlin"]
            if change == "network": facts["NetworkSettings"]["Networks"]["dokploy-network"] = {}
            if change == "alias": facts["NetworkSettings"]["Networks"]["app-private"]["Aliases"] = []
            if change == "mount": facts["Mounts"].append({"Type": "bind", "Destination": "/customer-files"})
            self.assertEqual(self.run_check(facts=facts), "scanner-config-mismatch")

    def test_loaded_version_utc_age_and_format(self):
        cases = [(self.version, None), ("ClamAV 1.5.4/28155/Wed Oct 14 12:00:00 2026", None),
                 ("ClamAV 1.5.4/28155/Wed Oct 14 11:59:59 2026", "scanner-signatures-stale"),
                 ("ClamAV 1.5.4/28155/Fri Oct 16 12:05:00 2026", None),
                 ("ClamAV 1.5.4/28155/Fri Oct 16 12:05:01 2026", "scanner-version-invalid"),
                 ("ClamAV 1.5.4/28155/Thu Oct 16 11:00:00 2026", "scanner-version-invalid"),
                 ("ClamAV 1.5.4/28155/Fri Oct 32 11:00:00 2026", "scanner-version-invalid"),
                 ("ClamAV 1.5.4", "scanner-version-invalid"), ("wrong", "scanner-version-invalid"),
                 (self.version.replace("1.5.4", "1.4.3"), "scanner-version-invalid")]
        for version, expected in cases:
            with self.subTest(version=version):
                self.assertEqual(monitor.scanner_version_problem(version, self.now), expected)

    def test_scanner_config_owner_only_and_exact_selectors(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scanner.json"
            config = {**self.config, "smtp_url": "smtps://fixture.invalid", "from": "fixture", "to": "fixture"}
            path.write_text(json.dumps(config))
            path.chmod(0o600)
            self.assertEqual(monitor.load_config(path)["scanner_project"], "scanner-project")
            for key, value in (("private_network", "dokploy-network"), ("web_project", "$(unsafe)")):
                path.write_text(json.dumps({**config, key: value}))
                with self.assertRaises(ValueError): monitor.load_config(path)
            path.write_text(json.dumps(config))
            path.chmod(0o644)
            with self.assertRaises(ValueError): monitor.load_config(path)

    def test_fixed_node_probe_protocol_without_network(self):
        # Execute the actual embedded probe in a VM with a fake socket, never a real endpoint.
        harness = r"""
const vm = require('node:vm'), {EventEmitter} = require('node:events');
const scenario = process.argv[1], source = process.argv[2];
let commandCount = 0;
const net = {createConnection(options) {
  if (options.host !== 'opendiscord-private-scanner' || options.port !== 3310) throw Error('route');
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.setTimeout = (ms, callback) => { if (ms !== 2000) throw Error('timeout'); socket.timeout = callback; };
  socket.write = command => {
    commandCount++;
    if (scenario === 'timeout') return queueMicrotask(socket.timeout);
    if (scenario === 'down') return queueMicrotask(() => socket.emit('error', Error('private')));
    let data = command === 'zPING\0' ? 'PONG\0' : 'ClamAV 1.5.4/28155/Fri Oct 16 11:00:00 2026\0';
    if (command !== 'zPING\0' && command !== 'zVERSION\0') throw Error('command');
    if (scenario === 'wrong-pong') data = 'WRONG\0';
    if (scenario === 'oversized') data = 'x'.repeat(4097);
    if (scenario === 'truncated') return queueMicrotask(() => socket.emit('end'));
    if (scenario === 'trailing') data += 'suffix';
    queueMicrotask(() => {
      socket.emit('data', Buffer.from(data.slice(0,2)));
      socket.emit('data', Buffer.from(data.slice(2)));
    });
  };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}};
vm.runInNewContext(source, {
 require: () => net, Buffer, console,
 process: {env: {CLAMAV_HOST: scenario === 'config' ? '' : 'opendiscord-private-scanner', CLAMAV_PORT:'3310'}, exit: process.exit},
 setTimeout: (callback, ms) => { if (ms !== 5000) throw Error('deadline'); return setTimeout(callback, ms); },
 clearTimeout
});
"""
        for scenario in ("healthy", "timeout", "down", "wrong-pong", "oversized", "truncated", "trailing", "config"):
            with self.subTest(scenario=scenario):
                result = subprocess.run(["node", "-e", harness, scenario, monitor.SCANNER_PROBE],
                                        capture_output=True, text=True, timeout=8, check=False)
                payload = json.loads(result.stdout)
                if scenario == "healthy":
                    self.assertEqual(result.returncode, 0)
                    self.assertEqual(payload, {"version": self.version})
                else:
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(payload, {"error": "scanner-config-mismatch" if scenario == "config" else "scanner-unavailable"})

    def test_scanner_alert_suppression_and_genuine_recovery(self):
        state, message = monitor.transition({}, "scanner-signatures-stale", self.now, 1)
        self.assertIsNotNone(message)
        state.update(notified_problem="scanner-signatures-stale", sent_at=self.now)
        state, message = monitor.transition(state, "scanner-unavailable", self.now + 300, 1)
        self.assertIsNone(message)
        self.assertEqual(monitor.transition(state, None, self.now + 600, 1)[1], "Recovered")
        self.assertIsNotNone(monitor.transition(state, "scanner-unavailable", self.now + 3600, 1)[1])


if __name__ == "__main__":
    unittest.main()
