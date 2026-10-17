"""Root-owned operator monitor; keeps credentials and alert state off public endpoints."""
import argparse
import datetime as dt
import email.message
import fcntl
import http.client
import json
import os
import smtplib
import ssl
import stat
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Literal, TypedDict


class MonitorConfig(TypedDict):
    mode: Literal["health", "backup", "voice"]
    smtp_url: str
    from_: str
    to: str


class MonitorState(TypedDict, total=False):
    problem: str | None
    failures: int
    notified_problem: str
    sent_at: float


def load_config(path: Path) -> MonitorConfig:
    info = path.stat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("Monitor configuration must be owner-only")
    config = json.loads(path.read_text())
    if config["mode"] not in ("health", "backup", "voice"):
        raise ValueError("Invalid monitor mode")
    return {"mode": config["mode"],
            "smtp_url": str(config["smtp_url"]), "from_": str(config["from"]), "to": str(config["to"])}


def check(config: MonitorConfig, now: float) -> str | None:
    if config["mode"] == "health":
        for route, expected in (("health", "ok"), ("ready", "ready")):
            try:
                request = urllib.request.Request("https://opendiscord.app/api/" + route,
                                                 headers={"User-Agent": "openDiscord-operator-monitor/1"})
                with urllib.request.urlopen(request, timeout=10) as response:
                    payload = json.loads(response.read(4097))
                    if response.status != 200 or payload != {"status": expected}:
                        return "public-" + route + "-unavailable"
            except (OSError, ValueError, http.client.HTTPException):
                return "public-" + route + "-unavailable"
        return None
    if config["mode"] == "voice":
        try:
            status = json.loads(Path("/var/lib/opendiscord-voice-maintenance/status.json").read_text())
            age = now - status["finished_at"]
            if age < -30 or age > 120:
                return "voice-invocations-stale"
            if status["sdk_failure_streak"] >= 6:
                return "voice-sdk-failures-sustained"
            if status["ok"] is not True:
                return "voice-job-failed"
            if status["limited_streak"] >= 6:
                return "voice-scheduling-pressure-sustained"
        except (OSError, ValueError, KeyError, TypeError):
            return "voice-status-unavailable"
        try:
            result = subprocess.run(["systemctl", "show", "opendiscord-voice-maintenance.service", "--property=Result", "--value"],
                                    capture_output=True, text=True, timeout=10, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return "voice-status-unavailable"
        if result.returncode or result.stdout.strip() != "success":
            return "voice-job-failed"
        return None
    try:
        marker = Path("/var/backups/opendiscord/last-success").read_text().split()[0]
        age = now - dt.datetime.fromisoformat(marker).timestamp()
        if age < -300 or age > 30 * 3600:
            return "backup-stale-or-invalid"
    except (OSError, ValueError, IndexError):
        return "backup-success-marker-missing"
    try:
        result = subprocess.run(["systemctl", "show", "opendiscord-backup.service", "--property=Result", "--value"],
                                capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return "backup-status-unavailable"
    if result.returncode or result.stdout.strip() != "success":
        return "backup-job-failed"
    return None


def send(config: MonitorConfig, subject: str, body: str) -> None:
    url = urllib.parse.urlsplit(config["smtp_url"])
    if url.scheme not in ("smtp", "smtps") or not url.hostname:
        raise ValueError("Invalid SMTP URL")
    message = email.message.EmailMessage()
    message["From"] = config["from_"]
    message["To"] = config["to"]
    message["Subject"] = "[openDiscord operations] " + subject
    message.set_content(body + "\n\nAutomated operator check; no account or message contents are included.\n")
    context = ssl.create_default_context()
    port = url.port or (465 if url.scheme == "smtps" else 587)
    factory = smtplib.SMTP_SSL if url.scheme == "smtps" else smtplib.SMTP
    options = {"context": context} if url.scheme == "smtps" else {}
    with factory(url.hostname, port, timeout=20, **options) as client:
        if url.scheme == "smtp":
            client.starttls(context=context)
        if url.username:
            client.login(urllib.parse.unquote(url.username), urllib.parse.unquote(url.password or ""))
        refused = client.send_message(message)
        if refused:
            raise ValueError("SMTP recipient refused")


def transition(state: MonitorState, problem: str | None, now: float, threshold: int) -> tuple[MonitorState, str | None]:
    """Compute a retryable notification; update delivery timestamps only after SMTP accepts it."""
    if problem:
        count = state.get("failures", 0) + 1
        updated: MonitorState = {**state, "problem": problem, "failures": count}
        notify = count >= threshold and (not state.get("notified_problem") or now - state.get("sent_at", 0) >= 3600)
        return updated, ("Failure: " + problem) if notify else None
    if state.get("notified_problem"):
        return {**state, "problem": None, "failures": 0}, "Recovered"
    return {"problem": None, "failures": 0}, None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--test-mail", action="store_true")
    args = parser.parse_args()
    config = load_config(args.config)
    if args.test_mail:
        send(config, "Delivery test", "The " + config["mode"] + " monitor can submit alerts to the configured operator mailbox.")
        print("Operator alert test accepted by SMTP")
        return
    state_dir = Path("/var/lib/opendiscord-monitor")
    state_dir.mkdir(mode=0o700, exist_ok=True)
    with (state_dir / (config["mode"] + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = state_dir / (config["mode"] + ".json")
        state: MonitorState = json.loads(path.read_text()) if path.exists() else {}
        now = time.time()
        problem = check(config, now)
        updated, notification = transition(state, problem, now, 3 if config["mode"] == "health" else 1)
        if notification:
            send(config, notification, "Monitor: " + config["mode"] + "\nStatus: " + (problem or "healthy"))
            if problem:
                updated.update(notified_problem=problem, sent_at=now)
            else:
                updated = {"problem": None, "failures": 0}
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(updated))
        temporary.replace(path)
        print(json.dumps({"monitor": config["mode"], "status": problem or "healthy", "notified": bool(notification)}))


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except Exception:  # noqa: BLE001 — sanitize third-party exceptions at the process boundary
        # SMTP/library exceptions can contain credentials or addresses; operator logs stay aggregate.
        print("Operator monitor failed; check private configuration, connectivity and SMTP availability.")
        raise SystemExit(1) from None
