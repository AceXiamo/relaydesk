"""Run actual local commands in temporary task worktrees against a fake queue."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from agent.relay import ApiError, Runner, git


class Queue:
    project = {"name": "test", "repo": "example/test", "id": "prj"}
    task = {"title": "导出", "body": "当前筛选", "requirements": "CSV", "id": "task1",
            "number": 1, "status": "working", "version": 2}

    def __init__(self):
        self.task = dict(self.task)
        self.events = []
        self.heartbeat_hook = lambda: None
        self.drop_finish_response = False
        self.fenced = False

    def call(self, route, data=None):
        if route == "project":
            return {"project": self.project}
        if route == "claim":
            self.events.append(route)
            task = dict(self.task, linked_feedback=[{"number": 2, "body": "保留表头"}])
            return {"project": self.project, "task": task, "lease": "opaque"}
        self.assert_lease(data)
        action = route.split("/")[1]
        if self.fenced:
            raise ApiError(409, "lease fenced")
        if action == "heartbeat":
            self.heartbeat_hook()
        else:
            self.events.append(action)
            if action == "finish" and self.drop_finish_response:
                self.drop_finish_response = False
                raise ApiError(0, "network error")
        return {"task": self.task.copy()}

    def assert_lease(self, data):
        assert data["lease"] == "opaque"


class RunnerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.repo = root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "remote", "add", "origin", "git@github.com:example/test.git")
        git(self.repo, "-c", "user.name=Test", "-c", "user.email=t@example.test",
            "commit", "--allow-empty", "-qm", "seed")
        self.state = root / "state"
        self.state.mkdir()
        lock = (self.state / "lock").open("a")
        self.addCleanup(lock.close)
        self.queue = Queue()
        command = [sys.executable, "-c", (
            "import os,sys,pathlib; assert 'RELAYDESK_AGENT_KEY' not in os.environ; "
            "pathlib.Path('answer').write_text(sys.stdin.read()); ")]
        self.runner = Runner(self.queue, self.repo, self.state, 0.1, command, lock)

    def test_worker_uses_private_tree_and_recovers_result(self):
        self.queue.drop_finish_response = True
        with patch.dict(os.environ, RELAYDESK_AGENT_KEY="secret"), self.assertRaises(ApiError):
            self.runner.cycle()
        result = next(self.state.glob("worktrees/*/answer")).read_text()
        self.assertIn("保留表头", result)
        self.assertNotIn("secret", result)
        self.assertFalse((self.repo / "answer").exists())
        self.assertEqual(json.loads(self.runner.journal.read_text())["phase"], "report")
        self.runner.cycle()
        self.assertFalse(self.runner.journal.exists())
        self.assertEqual(self.queue.events, ["claim", "finish", "finish"])

    def test_handoff_stops_process_and_keeps_partial_work(self):
        self.runner.command[-1] += "import time; time.sleep(30)"
        def request_takeover():
            if list(self.state.glob("worktrees/*/answer")):
                self.queue.task.update(status="handoff", version=3)
        self.queue.heartbeat_hook = request_takeover
        self.runner.cycle()
        self.assertEqual(self.queue.events, ["claim", "handoff"])
        self.assertFalse(self.runner.journal.exists())
        self.assertTrue(list(self.state.glob("worktrees/*/answer")))

    def test_fenced_runner_stops_without_posting_completion(self):
        self.runner.command[-1] += "import time; time.sleep(30)"
        def fence():
            if list(self.state.glob("worktrees/*/answer")):
                self.queue.fenced = True
                raise ApiError(409, "lease fenced")
        self.queue.heartbeat_hook = fence
        self.runner.cycle()
        self.assertEqual(self.queue.events, ["claim"])
        self.assertFalse(self.runner.journal.exists())

    def test_wrong_remote_never_claims(self):
        git(self.repo, "remote", "set-url", "origin", "https://github.com/example/different")
        with self.assertRaises(ValueError):
            self.runner.cycle()
        self.assertEqual(self.queue.events, [])

    def test_multi_repo_project_accepts_secondary_bound_repo(self):
        self.queue.project = {
            "name": "multi",
            "repo": "example/web",
            "repos": ["example/web", "example/test"],
            "id": "prj",
        }
        self.runner.cycle()
        self.assertEqual(self.queue.events, ["claim", "finish"])

