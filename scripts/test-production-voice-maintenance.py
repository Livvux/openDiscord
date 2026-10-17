"""Linux CI wrapper contract: no real Docker, credentials or operator messages."""
import fcntl
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("production-voice-maintenance.sh").resolve()
DOCKER = '''#!/usr/bin/env python3
import json,os,pathlib,sys
p=pathlib.Path(os.environ['FAKE_HOME']);args=sys.argv[1:]
with (p/'calls').open('a') as f:f.write(json.dumps(args)+'\\n')
if args[:2]==['image','inspect']:sys.exit(0)
if args[:2]==['ps','-aq']:
 if os.environ.get('FAKE_MODE')=='orphan':print('foreign-container')
elif args[:2]==['container','inspect']:
 if not (p/'container').exists():sys.exit(1)
 print((p/'container').read_text())
elif args[:2]==['rm','-f']:(p/'container').unlink()
elif args[0]=='compose':
 run=next(a.split('=',1)[1] for a in args if a.startswith('opendiscord.voice-maintenance.run='))
 (p/'container').write_text('immutable-container-id '+('foreign-run' if os.environ.get('FAKE_MODE')=='foreign' else run))
 print(json.dumps({'apply':True,'scanned':8,'closed':8,'removed':0,'limited':True,'rooms':{'claimed':1,'requests':1,'retired':1,'deleted':1,'failed':0,'unavailable':0,'limited':False}}))
 if os.environ.get('FAKE_MODE')=='failure':sys.exit(1)
'''
TIMEOUT = '''#!/usr/bin/env python3
import os,subprocess,sys
args=sys.argv[1:]
while args and (args[0].startswith('--') or args[0][0].isdigit()):args.pop(0)
code=subprocess.call(args)
sys.exit(124 if os.environ.get('FAKE_MODE')=='timeout' and 'compose' in args else code)
'''


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        for name, content in (("docker", DOCKER), ("timeout", TIMEOUT)):
            path = self.root / name
            path.write_text(content)
            path.chmod(0o755)
        self.state = self.root / "state"
        self.state.mkdir()
        self.env = {**os.environ, "PATH": str(self.root) + ":" + os.environ["PATH"],
                    "STATE_DIRECTORY": str(self.state), "FAKE_HOME": str(self.root),
                    "OPENDISCORD_COMPOSE_DIR": str(self.root), "OPENDISCORD_COMPOSE_PROJECT": "ci-project"}

    def run_job(self, mode=""):
        return subprocess.run(["bash", str(SCRIPT)], env={**self.env, "FAKE_MODE": mode}, capture_output=True, text=True, timeout=10)

    def calls(self):
        return [json.loads(line) for line in (self.root / "calls").read_text().splitlines()]

    def test_non_overlap_does_not_launch_or_modify_status(self):
        with (self.state / "job.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(self.run_job().returncode, 0)
        self.assertFalse((self.root / "calls").exists())
        self.assertFalse((self.state / "status.json").exists())

    def test_success_uses_existing_image_unique_labels_and_id_cleanup(self):
        self.assertEqual(self.run_job().returncode, 0)
        calls = self.calls()
        compose = next(call for call in calls if call[0] == "compose")
        self.assertIn("never", compose)
        self.assertIn("--no-deps", compose)
        self.assertNotIn("--build", compose)
        self.assertIn("scripts/voice-maintenance.ts", compose)
        self.assertTrue(any(arg.startswith("opendiscord.voice-maintenance.run=") for arg in compose))
        self.assertIn(["rm", "-f", "immutable-container-id"], calls)
        status = json.loads((self.state / "status.json").read_text())
        self.assertTrue(status["ok"])
        self.assertEqual(status["limited_streak"], 1)
        self.assertEqual(self.run_job().returncode, 0)
        self.assertEqual(json.loads((self.state / "status.json").read_text())["limited_streak"], 2)
        names = [call[call.index("--name") + 1] for call in self.calls() if call[0] == "compose"]
        self.assertEqual(len(set(names)), 2)

    def test_timeout_and_failure_remove_only_the_created_container(self):
        for mode in ("timeout", "failure"):
            with self.subTest(mode=mode):
                self.assertNotEqual(self.run_job(mode).returncode, 0)
                self.assertIn(["rm", "-f", "immutable-container-id"], self.calls())
                self.assertFalse(json.loads((self.state / "status.json").read_text())["ok"])

    def test_orphan_and_foreign_run_are_preserved(self):
        self.assertNotEqual(self.run_job("orphan").returncode, 0)
        self.assertFalse(any(call[0] in ("compose", "rm") for call in self.calls()))
        self.assertNotEqual(self.run_job("foreign").returncode, 0)
        self.assertTrue((self.root / "container").exists())
        self.assertFalse(any(call[0] == "rm" for call in self.calls()))


if __name__ == "__main__":
    unittest.main()
