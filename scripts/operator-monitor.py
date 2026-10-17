"""Root-owned operator monitor; keeps credentials and alert state off public endpoints."""
import argparse
import datetime as dt
import email.message
import fcntl
import http.client
import json
import os
import re
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
    mode: Literal["health", "backup", "voice", "scanner"]
    smtp_url: str
    from_: str
    to: str
    web_project: str
    web_service: str
    scanner_project: str
    private_network: str


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
    if config["mode"] not in ("health", "backup", "voice", "scanner"):
        raise ValueError("Invalid monitor mode")
    result = {"mode": config["mode"],
              "smtp_url": str(config["smtp_url"]), "from_": str(config["from"]), "to": str(config["to"])}
    if config["mode"] == "scanner":
        for key in ("web_project", "web_service", "scanner_project", "private_network"):
            value = config[key]
            if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", value):
                raise ValueError("Invalid scanner deployment selector")
            result[key] = value
        if result["private_network"] == "dokploy-network":
            raise ValueError("Scanner requires the app-private network")
    return result


SCANNER_IMAGE = "clamav/clamav:1.5.4@sha256:638d90201ee7ee6a82d249a2fc23b132e578673b5f1f2766852b127676ca1ef6"
SCANNER_ALIAS = "opendiscord-private-scanner"
# Runs in the real web namespace. Never emits environment values or third-party errors.
SCANNER_PROBE = r"""
const net = require('node:net');
const fail = () => { console.log(JSON.stringify({error:'scanner-unavailable'})); process.exit(1); };
if (process.env.CLAMAV_HOST !== 'opendiscord-private-scanner' ||
    (process.env.CLAMAV_PORT || '3310') !== '3310') {
  console.log(JSON.stringify({error:'scanner-config-mismatch'})); process.exit(1);
}
const deadline = setTimeout(fail, 5000);
async function query(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host:process.env.CLAMAV_HOST, port:3310});
    let data = Buffer.alloc(0), done = false;
    const finish = (error, value) => {
      if (done) return; done = true; socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(2000, () => finish(new Error()));
    socket.on('error', () => finish(new Error()));
    socket.on('end', () => finish(new Error()));
    socket.on('connect', () => socket.write('z' + command + '\0'));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 4096) return finish(new Error());
      const end = data.indexOf(0);
      if (end !== -1) {
        if (end !== data.length - 1 || !data.subarray(0,end).every(x => x >= 32 && x <= 126))
          return finish(new Error());
        finish(null, data.subarray(0,end).toString('ascii'));
      }
    });
  });
}
(async () => {
  if (await query('PING') !== 'PONG') return fail();
  const version = await query('VERSION');
  clearTimeout(deadline);
  console.log(JSON.stringify({version}));
})().catch(fail);
"""


def docker_json(arguments: list[str]) -> object:
    result = subprocess.run(["docker", *arguments], capture_output=True, text=True, timeout=10, check=False)
    if result.returncode or len(result.stdout) > 65536:
        raise ValueError("Docker probe failed")
    return json.loads(result.stdout)


def scanner_container(project: str, service: str) -> str:
    result = subprocess.run(["docker", "ps", "--all", "--filter", "label=com.docker.compose.project=" + project,
                             "--filter", "label=com.docker.compose.service=" + service,
                             "--format", "{{.ID}}"], capture_output=True, text=True, timeout=10, check=False)
    ids = result.stdout.split()
    if result.returncode or len(ids) != 1 or not re.fullmatch(r"[a-f0-9]{12,64}", ids[0]):
        raise ValueError("Missing or ambiguous deployment")
    return ids[0]


def scanner_version_problem(version: str, now: float) -> str | None:
    # clamd 1.5.4 session.c print_ver uses loaded DB_TIME + cli_ctime, in container TZ.
    match = re.fullmatch(r"ClamAV 1\.5\.4/([1-9][0-9]*)/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) "
                         r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 0-9][0-9]) "
                         r"([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})", version)
    if not match:
        return "scanner-version-invalid"
    _, weekday, month, day, hour, minute, second, year = match.groups()
    try:
        months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
        stamp = dt.datetime(int(year), months.index(month) + 1, int(day), int(hour), int(minute), int(second), tzinfo=dt.UTC)
        if "Mon Tue Wed Thu Fri Sat Sun".split()[stamp.weekday()] != weekday:
            return "scanner-version-invalid"
    except ValueError:
        return "scanner-version-invalid"
    age = now - stamp.timestamp()
    if age < -300:
        return "scanner-version-invalid"
    return "scanner-signatures-stale" if age > 48 * 3600 else None


def check_scanner(config: MonitorConfig, now: float) -> str | None:
    try:
        web = scanner_container(config["web_project"], config["web_service"])
        scanner = scanner_container(config["scanner_project"], "scanner")
        info = docker_json(["inspect", scanner, "--format", "{{json .}}"])
        state, settings = info["State"], info["HostConfig"]
        if not state["Running"] or state.get("OOMKilled") or state.get("Health", {}).get("Status") != "healthy":
            return "scanner-container-unhealthy"
        networks = info["NetworkSettings"]["Networks"]
        private = config["private_network"]
        web_networks = docker_json(["inspect", web, "--format", "{{json .NetworkSettings.Networks}}"])
        if (info["Config"]["Image"] != SCANNER_IMAGE or settings["Memory"] != 4294967296
                or settings.get("MemorySwap") != 4294967296 or settings.get("PortBindings")
                or settings.get("Privileged") or settings.get("NetworkMode") == "host"
                or "TZ=Etc/UTC" not in info["Config"]["Env"]
                or private not in networks or private not in web_networks
                or SCANNER_ALIAS not in networks[private].get("Aliases", [])
                or "dokploy-network" in networks or len(networks) != 2):
            return "scanner-config-mismatch"
        egress = next(name for name in networks if name != private)
        network = docker_json(["network", "inspect", egress, "--format", "{{json .}}"])
        mounts = info["Mounts"]
        if (network.get("Internal") or network.get("Driver") != "bridge"
                or network.get("Labels", {}).get("com.docker.compose.project") != config["scanner_project"]
                or network.get("Labels", {}).get("com.docker.compose.network") != "default"
                or len(mounts) != 1 or mounts[0].get("Type") != "volume"
                or mounts[0].get("Destination") != "/var/lib/clamav" or not mounts[0].get("RW")
                or settings.get("LogConfig") != {"Type": "json-file", "Config": {"max-size": "10m", "max-file": "3"}}):
            return "scanner-config-mismatch"
        result = subprocess.run(["docker", "top", scanner, "-eo", "pid,args"], capture_output=True, text=True, timeout=10, check=False)
        # Docker rejects ps formats without a PID column; drop it before matching.
        processes = [line.split()[1:] for line in result.stdout.splitlines()[1:]]
        if result.returncode or not any(words and words[0] in ("freshclam", "/usr/bin/freshclam")
                                       and "--daemon" in words and "--foreground" in words for words in processes):
            return "scanner-update-process-missing"
        result = subprocess.run(["docker", "exec", web, "node", "-e", SCANNER_PROBE],
                                capture_output=True, text=True, timeout=7, check=False)
        if len(result.stdout) > 8192:
            return "scanner-unavailable"
        probe = json.loads(result.stdout)
        if probe.get("error") == "scanner-config-mismatch":
            return "scanner-config-mismatch"
        if result.returncode or "error" in probe:
            return "scanner-unavailable"
        return scanner_version_problem(probe["version"], now)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired):
        return "scanner-unavailable"


def check(config: MonitorConfig, now: float) -> str | None:
    if config["mode"] == "scanner":
        return check_scanner(config, now)
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
