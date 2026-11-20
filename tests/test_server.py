import json
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Thread
import unittest
from unittest.mock import patch

from server import Handler, QueueServer, Store


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db = Path(self.directory.name) / "queue.sqlite3"
        self.server = QueueServer(("127.0.0.1", 0), self.db)
        self.port = self.server.server_port
        self.addCleanup(self.server.server_close)
        thread = Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)
        self.log = patch.object(Handler, "log_message")
        self.log.start()
        self.addCleanup(self.log.stop)
        self.project = self.ok("/api/projects", {"name": "Demo", "repo": "https://github.com/acme/demo.git"})["project"]
        self.base = "/api/projects/" + self.project["id"]

    def request(self, path, body=None, key=None, method=None, **headers):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=4)
        if key is not None:
            headers["Authorization"] = "Bearer " + key
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            conn.request(method or ("GET" if body is None else "POST"), path,
                         None if body is None else json.dumps(body), headers=headers)
            response = conn.getresponse()
            raw = response.read()
            return response.status, json.loads(raw) if raw else None, dict(response.headers)
        finally:
            conn.close()

    def ok(self, *args, **kwargs):
        status, data, _ = self.request(*args, **kwargs)
        self.assertEqual(status, 200, data)
        return data

    def task(self):
        task = self.ok(self.base + "/tasks", {"title": "Issue", "body": "Steps"})["task"]
        return "/api/tasks/" + task["id"]

    def ready(self, path):
        self.ok(path + "/action", {"action": "status", "status": "ready"})

    def claim(self):
        return self.ok(self.base + "/agent/claim", {}, self.project["agent_key"])

    def test_claim_race_and_fencing(self):
        path = self.task()
        self.ready(path)
        gate = Barrier(2)

        def human():
            gate.wait()
            return self.request(path + "/action", {"action": "claim"})[0]

        def agent():
            gate.wait()
            return self.claim()["task"]

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(human)
            second = pool.submit(agent)
            owned_by_human = first.result() == 200
            owned_by_agent = second.result() is not None
        self.assertNotEqual(owned_by_human, owned_by_agent)
        self.assertIsNone(self.claim()["task"])

    def test_agent_handoff_and_stale_requirements(self):
        path = self.task()
        self.ready(path)
        claim = self.claim()
        t = claim["task"]
        base = self.base + "/agent/" + t["id"]
        key = self.project["agent_key"]
        data = {"lease": claim["lease"], "version": t["version"], "body": "branch: work/demo"}
        self.ok(path + "/messages", {"body": "Can you explain this?"})
        heartbeat = self.ok(base + "/heartbeat", data, key)["task"]
        self.assertEqual(t["version"], heartbeat["version"])
        changed = self.ok(path + "/action", {"action": "requirements", "body": "Scope change"})["task"]
        self.assertEqual(self.request(base + "/finish", data, key)[0], 409)
        self.ok(path + "/action", {"action": "takeover"})
        self.assertEqual(self.request(base + "/finish", {**data, "version": changed["version"]}, key)[0], 409)
        self.assertEqual(self.ok(base + "/heartbeat", data, key)["task"]["status"], "handoff")
        self.assertEqual(self.ok(base + "/handoff", data, key)["task"]["owner"], "human")
        self.assertEqual(self.request(base + "/heartbeat", data, key)[0], 409)
        self.assertIn("branch: work/demo", self.ok(path)["messages"][-1]["body"])
        self.ok(path + "/action", {"action": "release"})
        second = self.claim()
        self.assertNotEqual(second["lease"], claim["lease"])
        self.assertEqual(self.request(base + "/fail", data, key)[0], 409)
        self.ok(path + "/action", {"action": "takeover"})
        self.ok(path + "/action", {"action": "force_takeover"})
        self.assertEqual(self.request(base + "/finish", {**data, "lease": second["lease"]}, key)[0], 409)
        self.assertEqual(self.ok(path)["task"]["owner"], "human")

    def test_operator_auth_origins_and_idempotent_intake(self):
        self.assertEqual(self.request("/api/projects", Host="attacker.test")[0], 403)
        self.assertEqual(self.request(self.base, Origin="https://other.test")[0], 403)
        self.assertEqual(self.request(self.base, **{"X-Forwarded-For": "127.0.0.1"})[0], 403)
        allowed = "https://demo.test"
        project = self.ok(self.base, {"allowed_origins": [allowed], "agent_instructions": "run tests"}, method="PATCH")["project"]
        self.assertEqual(project["repo"], "acme/demo")
        url = self.base + "/intake"
        payload = {"body": "Broken button", "source": "widget", "external_id": "ev01"}
        key = project["intake_key"]
        self.assertEqual(self.request(url, payload, key, Origin="https://evil.test")[0], 403)
        self.assertEqual(self.request(url, payload, project["bot_key"], Origin=allowed)[0], 401)
        status, _, headers = self.request(url, method="OPTIONS", Origin=allowed)
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], allowed)
        first = self.ok(url, payload, key, Origin=allowed)
        self.assertEqual(first, self.ok(url, payload, key, Origin=allowed))
        task_url = "/api/tasks/" + first["task_id"]
        self.assertEqual(self.ok(task_url)["task"]["status"], "triage")
        self.assertIsNone(self.claim()["task"])
        self.ready(task_url)
        claimed = self.claim()
        self.assertEqual(claimed["project"]["agent_instructions"], "run tests")
        self.assertNotIn("agent_key", claimed["project"])
        accepted = self.ok(self.base + "/agent/" + first["task_id"] + "/finish", {
            "lease": claimed["lease"], "version": claimed["task"]["version"], "body": "Changes in branch work/fix"
        }, project["agent_key"])
        self.assertEqual(accepted["task"]["status"], "review")
        self.server.admin_token = "test-admin"
        self.assertEqual(self.request(self.base, key=key)[0], 401)
        self.assertEqual(self.ok(self.base, key="test-admin")["project"]["id"], project["id"])
        self.assertEqual(self.request(self.base, key="test-admin", Origin="https://evil.test")[0], 403)
        self.assertEqual(self.request(url, {**payload, "source": "bot"}, project["bot_key"])[0], 200)

    def test_merge_preserves_provenance_and_discussion(self):
        primary, dup = self.task(), self.task()
        self.ok(dup + "/messages", {"body": "A follow-up"})
        self.ready(dup)
        target = self.ok(primary)["task"]
        self.ok(dup + "/action", {"action": "merge", "target_id": target["id"]})
        self.assertEqual(self.ok(dup)["task"]["merged_into"], target["id"])
        self.assertIn("A follow-up", [m["body"] for m in self.ok(dup)["messages"]])
        self.assertEqual(len(self.ok(primary)["merged"]), 1)
        self.assertIsNone(self.claim()["task"])
        self.assertEqual(self.request(dup + "/action", {"action": "status", "status": "ready"})[0], 409)
        self.ready(primary)
        claim = self.claim()
        self.assertEqual(len(claim["task"]["linked_feedback"]), 1)
        with Store(self.db).connect() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM tasks").fetchone()[0], 2)

    def test_discussion_and_clarification_scope(self):
        path = self.task()
        with patch("assistant_chat.operator_reply", return_value="Try checking pagination") as answer:
            reply = self.ok(path + "/discuss", {"body": "Any clues?"})
        project, task, thread, question = answer.call_args.args
        self.assertNotIn("agent_key", project)
        self.assertEqual(question, "Any clues?")
        self.assertEqual(task["status"], "triage")
        self.assertTrue(thread)
        detail = self.ok(path)
        self.assertEqual(detail["task"]["version"], 1)
        self.assertEqual(detail["messages"][-1]["body"], reply["reply"])
        with patch("assistant_chat.intake_reply", return_value="Which page?") as clarify:
            self.ok(self.base + "/clarify", {"body": "Export broken"}, self.project["intake_key"])
        clarify.assert_called_once_with("Export broken", "")


if __name__ == "__main__":
    unittest.main()
