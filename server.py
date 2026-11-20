#!/usr/bin/env python3
"""Relaydesk project queue. Requires Python 3.10+ and SQLite."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hmac
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import threading
import time
from collections import deque
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
from uuid import uuid4
import base64

ROOT = Path(__file__).resolve().parent
STATUSES = {"triage", "ready", "working", "waiting", "review", "done"}
PRIORITIES = {"low", "normal", "high", "urgent"}
PUBLIC_PROJECT = "id, name, repo, created_at"
AGENT_PROJECT = ("id", "name", "repo", "agent_instructions")
SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL,
    intake_key TEXT NOT NULL, bot_key TEXT NOT NULL, agent_key TEXT NOT NULL,
    allowed_origins TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
    agent_instructions TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    requirements TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '', external_id TEXT,
    priority TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'none',
    lease TEXT, version INTEGER NOT NULL DEFAULT 1, merged_into TEXT REFERENCES tasks(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen TEXT,
    UNIQUE(project_id, number), UNIQUE(project_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS queue ON tasks(project_id, status, owner);
CREATE INDEX IF NOT EXISTS merged ON tasks(merged_into);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thread ON messages(task_id,id);
"""


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def field(data, name, limit, required=True):
    value = data.get(name, "")
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ApiError(400, f"Invalid {name} (maximum {limit} characters)")
    return value.strip()


def repository(value):
    match = re.fullmatch(r"(?:https://github\.com/)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?", value, re.ASCII | re.I)
    if not match or any(x in {".", ".."} for x in match.groups()):
        raise ApiError(400, "Use a GitHub owner/repository or repository URL")
    return "/".join(match.groups())


def origins(values):
    if not isinstance(values, list) or len(values) > 100:
        raise ApiError(400, "allowed_origins must be a list of origins")
    result = []
    for value in values:
        if not isinstance(value, str) or len(value) > 512:
            raise ApiError(400, "Invalid origin")
        url = urlsplit(value)
        if (url.scheme not in {"http", "https"} or not url.hostname or url.username or
                url.password or url.query or url.fragment or url.path not in {"", "/"}):
            raise ApiError(400, "Use an HTTP(S) origin without a path")
        result.append(value.rstrip("/"))
    return json.dumps(result)


def local_host(name):
    if name == "localhost":
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def task_view(row):
    return {k: row[k] for k in row.keys() if k not in {"lease", "external_id"}}


def project_view(row):
    result = dict(row)
    if "allowed_origins" in result:
        result["allowed_origins"] = json.loads(result["allowed_origins"])
    return result


class Store:
    def __init__(self, db):
        self.db = db
        conn = sqlite3.connect(self.db)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
            conn.execute("BEGIN IMMEDIATE")
            if "agent_instructions" not in {row[1] for row in conn.execute("PRAGMA table_info(projects)")}:
                conn.execute("ALTER TABLE projects ADD COLUMN agent_instructions TEXT NOT NULL DEFAULT ''")
            conn.commit()
        finally:
            conn.close()

    @contextmanager
    def connect(self, write=False):
        conn = sqlite3.connect(self.db, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield conn
            conn.commit()
        finally:
            conn.close()


def single(conn, sql, args=()):
    row = conn.execute(sql, args).fetchone()
    if row is None:
        raise ApiError(404, "Record not found")
    return row


def project_row(conn, project_id):
    return single(conn, "SELECT * FROM projects WHERE id=?", (project_id,))


def task_row(conn, task_id):
    return single(conn, "SELECT * FROM tasks WHERE id=?", (task_id,))


def add_message(conn, task_id, kind, author, body):
    created = now()
    cursor = conn.execute("INSERT INTO messages(task_id,kind,author,body,created_at) VALUES(?,?,?,?,?)",
                          (task_id, kind, author, body, created))
    conn.execute("UPDATE tasks SET updated_at=? WHERE id=?", (created, task_id))
    return dict(id=cursor.lastrowid, kind=kind, author=author, body=body, created_at=created)


def create_task(conn, project_id, data, source):
    body = field(data, "body", 24000)
    title = field(data, "title", 180, False) or body.splitlines()[0][:120]
    priority = field(data, "priority", 10, False) or "normal"
    if priority not in PRIORITIES:
        raise ApiError(400, "Unknown priority")
    source_url = field(data, "source_url", 2000, False)
    if source_url and (urlsplit(source_url).scheme not in {"http", "https"} or not urlsplit(source_url).hostname):
        raise ApiError(400, "source_url must be an HTTP(S) URL")
    external_id = field(data, "external_id", 256, False) or None
    if external_id:
        previous = conn.execute("SELECT * FROM tasks WHERE project_id=? AND source=? AND external_id=?",
                                (project_id, source, external_id)).fetchone()
        if previous:
            return previous
    num = conn.execute("SELECT COALESCE(MAX(number),0)+1 FROM tasks WHERE project_id=?", (project_id,)).fetchone()[0]
    task_id = uuid4().hex
    created = now()
    conn.execute("""INSERT INTO tasks(id,number,project_id,title,body,source,source_url,external_id,
                    priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'triage',?,?)""",
                 (task_id, num, project_id, title, body, source, source_url, external_id, priority, created, created))
    add_message(conn, task_id, "event", "system", "Feedback received")
    return task_row(conn, task_id)


def update_task(conn, task, **changes):
    changes.update(updated_at=now(), version=task["version"] + 1)
    fields = ", ".join(f"{key}=?" for key in changes)
    conn.execute(f"UPDATE tasks SET {fields} WHERE id=?", (*changes.values(), task["id"]))


def check_version(data, task, required=False):
    if (required or "version" in data) and (type(data.get("version")) is not int or data["version"] != task["version"]):
        raise ApiError(409, "Task changed. Refresh before continuing.")


def operator_action(conn, task, data):
    check_version(data, task)
    action = field(data, "action", 32)
    owner = task["owner"]
    status = task["status"]
    if task["merged_into"]:
        raise ApiError(409, "Open the primary task to continue")
    if action == "claim" and owner == "none" and status != "done":
        changes, event = dict(owner="human"), "Assigned to operator"
    elif action == "release" and owner == "human":
        changes = dict(owner="none", status="ready" if status == "working" else status)
        event = "Released by operator"
    elif action == "takeover" and owner == "agent" and status == "working":
        changes, event = dict(status="handoff"), "Operator requested handoff"
    elif action == "force_takeover" and owner == "agent" and status == "handoff":
        changes = dict(owner="human", status="working", lease=None)
        event = "Operator took ownership and revoked the agent lease"
    elif action == "requirements":
        body = field(data, "body", 24000, required=False)
        changes, event = dict(requirements=body), f"Updated requirements\n{body}"
    elif action == "status" and owner != "agent":
        new_status = field(data, "status", 16)
        if new_status not in STATUSES:
            raise ApiError(400, "Invalid status")
        if new_status == "working" and owner != "human":
            raise ApiError(409, "Claim the task before starting work")
        changes = dict(status=new_status)
        if new_status == "done":
            changes["owner"] = "none"
        event = f"{status} → {new_status}"
    elif action == "merge" and owner != "agent":
        target_id = field(data, "target_id", 64)
        target = task_row(conn, target_id)
        if (target["project_id"] != task["project_id"] or target_id == task["id"] or
                target["owner"] == "agent" or target["merged_into"] or target["status"] == "done"):
            raise ApiError(409, "Select an open, unmerged task in this project without an active agent")
        conn.execute("UPDATE tasks SET merged_into=? WHERE merged_into=?", (target_id, task["id"]))
        changes = dict(merged_into=target_id, status="done", owner="none")
        event = f"Merged into #{target['number']}"
        update_task(conn, target)
        add_message(conn, target_id, "event", "human", f"Linked feedback #{task['number']}: {task['title']}")
    else:
        raise ApiError(409, "Action unavailable for the current owner or status")
    update_task(conn, task, **changes)
    add_message(conn, task["id"], "event", "human", event)
    return {"task": task_view(task_row(conn, task["id"]))}


def agent_call(conn, project, parts, data):
    project_id = project["id"]
    public = {k: project[k] for k in AGENT_PROJECT}
    if parts == ["claim"]:
        task = conn.execute("""SELECT * FROM tasks WHERE project_id=? AND status='ready' AND owner='none'
            AND merged_into IS NULL ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
            WHEN 'normal' THEN 2 ELSE 3 END, number LIMIT 1""", (project_id,)).fetchone()
        if not task:
            return {"task": None}
        lease = secrets.token_urlsafe(32)
        update_task(conn, task, lease=lease, owner="agent", status="working", last_seen=now())
        add_message(conn, task["id"], "event", "agent", "Local agent claimed task")
        acquired = task_view(task_row(conn, task["id"]))
        acquired["linked_feedback"] = [task_view(row) for row in conn.execute(
            "SELECT * FROM tasks WHERE merged_into=? ORDER BY number", (task["id"],))]
        return {"task": acquired, "lease": lease, "project": public}
    if len(parts) != 2:
        raise ApiError(404, "Unknown agent operation")
    task_id, operation = parts
    task = task_row(conn, task_id)
    if task["project_id"] != project_id:
        raise ApiError(404, "Task not found")
    lease = field(data, "lease", 128)
    if task["owner"] != "agent" or not task["lease"] or not hmac.compare_digest(task["lease"].encode(), lease.encode()):
        raise ApiError(409, "Lease is no longer active")
    if operation == "heartbeat":
        conn.execute("UPDATE tasks SET last_seen=? WHERE id=?", (now(), task_id))
    else:
        if operation == "handoff" and task["status"] == "handoff":
            status, owner, fallback = "working", "human", "Agent handed over task"
        elif operation == "finish" and task["status"] == "working":
            check_version(data, task, required=True)
            status, owner, fallback = "review", "none", "Agent submitted task for review"
        elif operation == "fail" and task["status"] == "working":
            status, owner, fallback = "waiting", "none", "Agent needs assistance"
        else:
            raise ApiError(409, "Agent must honor the current task state")
        body = field(data, "body", 24000, False)
        update_task(conn, task, lease=None, status=status, owner=owner, last_seen=now())
        add_message(conn, task_id, "event", "agent", fallback + ("\n" + body if body else ""))
    return {"task": task_view(task_row(conn, task_id))}


class QueueServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, db, admin_token="", public_dir=None):
        self.store = Store(db)
        self.admin_token = admin_token
        self.public_dir = (public_dir or ROOT / "public").resolve()
        self.rate_lock = threading.Lock()
        self.traffic = {}
        self.assistant_slots = threading.BoundedSemaphore(4)
        super().__init__(address, Handler)

    def rate_limit(self, key, limit):
        moment = time.monotonic()
        with self.rate_lock:
            events = self.traffic.setdefault(key, deque())
            while events and events[0] <= moment - 60:
                events.popleft()
            if len(events) >= limit:
                raise ApiError(429, "Too many requests. Try again in a minute.")
            events.append(moment)


class Handler(BaseHTTPRequestHandler):
    server_version = "Relaydesk"
    timeout = 15

    def log_message(self, fmt, *args):
        # Avoid request lines containing user-provided query strings or credentials.
        if len(args) > 1 and str(args[1]).isdigit():
            super().log_message("%s %s", self.command, args[1])

    def reply(self, status, payload, mime="application/json; charset=utf-8"):
        content = json.dumps(payload, ensure_ascii=False).encode() if isinstance(payload, dict) else payload
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        if getattr(self, "admin_challenge", False):
            self.send_header("WWW-Authenticate", 'Basic realm="Relaydesk"')
        if getattr(self, "cors_origin", None):
            self.send_header("Access-Control-Allow-Origin", self.cors_origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        if self.command != "HEAD" and content:
            self.wfile.write(content)

    def operator(self):
        host = self.headers.get("Host", "")
        hostname = urlsplit("//" + host).hostname
        origin = self.headers.get("Origin")
        if origin and origin not in {"http://" + host, "https://" + host}:
            raise ApiError(403, "Operator actions require a same-origin request")
        token = self.server.admin_token
        if token:
            auth = self.headers.get("Authorization", "")
            supplied = ""
            if auth.startswith("Bearer "):
                supplied = auth[7:]
            elif auth.startswith("Basic "):
                try:
                    supplied = base64.b64decode(auth[6:], validate=True).decode().split(":", 1)[1]
                except (ValueError, UnicodeError, IndexError):
                    pass
            if not hmac.compare_digest(token.encode(), supplied.encode()):
                self.admin_challenge = True
                raise ApiError(401, "Enter the operator password configured on this server")
        elif not (local_host(self.server.server_address[0]) and local_host(hostname) and local_host(self.client_address[0])
                  and not any(self.headers.get(h) for h in ("Forwarded", "X-Forwarded-Host", "X-Forwarded-For"))):
            raise ApiError(403, "Remote operator access requires RELAYDESK_ADMIN_TOKEN")

    def bearer(self, expected):
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + expected).encode()):
            raise ApiError(401, "Invalid project credential")

    def widget_origin(self, project):
        origin = self.headers.get("Origin")
        if not origin:
            return
        allowed = json.loads(project["allowed_origins"])
        if origin == "null" or (allowed and origin not in allowed):
            raise ApiError(403, "This origin is not enabled for the project")
        self.cors_origin = origin

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise ApiError(415, "Send application/json")
        size = int(self.headers.get("Content-Length", "0"))
        if size < 0 or size > 160000:
            raise ApiError(413, "Request too large")
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise ApiError(400, "Expected a JSON object")
        return data

    def store_api(self, conn, parts, data):
        method = self.command
        if parts == ["projects"]:
            if method == "GET":
                rows = conn.execute(f"SELECT {PUBLIC_PROJECT} FROM projects ORDER BY created_at")
                return {"projects": [dict(r) for r in rows]}
            if method == "POST":
                name = field(data, "name", 100)
                repo = repository(field(data, "repo", 200))
                project_id = uuid4().hex
                keys = [secrets.token_urlsafe(32) for _ in range(3)]
                conn.execute("""INSERT INTO projects(id,name,repo,intake_key,bot_key,agent_key,allowed_origins,
                                created_at,agent_instructions) VALUES(?,?,?,?,?,?,?,?,?)""",
                             (project_id, name, repo, *keys, origins(data.get("allowed_origins", [])), now(),
                              field(data, "agent_instructions", 8000, False)))
                return {"project": project_view(project_row(conn, project_id))}
        if len(parts) >= 2 and parts[0] == "projects":
            project_id = parts[1]
            project = project_row(conn, project_id)
            if len(parts) == 2:
                if method == "GET":
                    return {"project": project_view(project)}
                if method == "PATCH":
                    name = field(data, "name", 100) if "name" in data else project["name"]
                    repo = repository(field(data, "repo", 200)) if "repo" in data else project["repo"]
                    if repo != project["repo"] and conn.execute(
                            "SELECT 1 FROM tasks WHERE project_id=? AND owner='agent'", (project_id,)).fetchone():
                        raise ApiError(409, "Complete active handoffs before rebinding the repository")
                    allowed = origins(data["allowed_origins"]) if "allowed_origins" in data else project["allowed_origins"]
                    instructions = field(data, "agent_instructions", 8000, False) if "agent_instructions" in data else project["agent_instructions"]
                    conn.execute("UPDATE projects SET name=?,repo=?,allowed_origins=?,agent_instructions=? WHERE id=?",
                                 (name, repo, allowed, instructions, project_id))
                    return {"project": project_view(project_row(conn, project_id))}
            if parts[2:] == ["tasks"]:
                if method == "GET":
                    rows = conn.execute("SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC, number DESC", (project_id,))
                    return {"tasks": [task_view(r) for r in rows]}
                if method == "POST":
                    return {"task": task_view(create_task(conn, project_id, data, "console"))}
            if parts[2:] == ["intake"] and method == "POST":
                self.widget_origin(project)
                source = field(data, "source", 12)
                if source not in {"widget", "bot"}:
                    raise ApiError(400, "Unknown feedback source")
                self.bearer(project["bot_key" if source == "bot" else "intake_key"])
                self.server.rate_limit((project_id, "intake"), 120)
                task = create_task(conn, project_id, data, source)
                return {"task_id": task["id"], "number": task["number"]}
            if parts[2:3] == ["agent"]:
                self.bearer(project["agent_key"])
                if method == "GET" and parts[3:] == ["project"]:
                    return {"project": {k: project[k] for k in AGENT_PROJECT}}
                if method == "POST":
                    return agent_call(conn, project, parts[3:], data)
        if len(parts) >= 2 and parts[0] == "tasks":
            task = task_row(conn, parts[1])
            if len(parts) == 2 and method == "GET":
                thread = conn.execute("SELECT * FROM messages WHERE task_id=? ORDER BY id", (task["id"],))
                merged = conn.execute("SELECT * FROM tasks WHERE merged_into=? ORDER BY number", (task["id"],))
                return {"task": task_view(task), "messages": [dict(r) for r in thread], "merged": [task_view(r) for r in merged]}
            if parts[2:] == ["messages"] and method == "POST":
                return {"message": add_message(conn, task["id"], "comment", "human", field(data, "body", 12000))}
            if parts[2:] == ["action"] and method == "POST":
                return operator_action(conn, task, data)
        raise ApiError(404, "Unknown API endpoint")

    def chat(self, parts, data):
        import assistant_chat
        body = field(data, "body", 8000)
        store = self.server.store
        clarify = parts[0] == "projects"
        with store.connect() as conn:
            if clarify:
                project = project_row(conn, parts[1])
                self.widget_origin(project)
                self.bearer(project["intake_key"])
                self.server.rate_limit((project["id"], "clarify"), 20)
            else:
                task = task_view(task_row(conn, parts[1]))
                record = project_row(conn, task["project_id"])
                project = {k: record[k] for k in AGENT_PROJECT}
                messages = [dict(r) for r in conn.execute(
                    "SELECT * FROM messages WHERE task_id=? ORDER BY id DESC LIMIT 30", (task["id"],))][::-1]
        if not self.server.assistant_slots.acquire(blocking=False):
            raise ApiError(429, "Assistant is busy. Try again shortly.")
        try:
            if clarify:
                expected = field(data, "expected", 8000, False)
                result = assistant_chat.intake_reply(body, expected)
            else:
                result = assistant_chat.operator_reply(project, task, messages, body)
                with store.connect(write=True) as conn:
                    add_message(conn, task["id"], "comment", "human", body)
                    add_message(conn, task["id"], "comment", "assistant", result)
        except (RuntimeError, OSError) as exc:
            raise ApiError(502, "Assistant could not complete the reply") from exc
        finally:
            self.server.assistant_slots.release()
        return {"reply": result}

    def dispatch(self):
        path = unquote(urlsplit(self.path).path)
        if not path.startswith("/api/"):
            if self.command not in ("GET", "HEAD"):
                raise ApiError(405, "Method not allowed")
            base = self.server.public_dir
            requested = (base / (path.lstrip("/") or "index.html")).resolve()
            if base not in requested.parents or not requested.is_file():
                raise ApiError(404, "File not found")
            mime = mimetypes.guess_type(str(requested))[0] or "application/octet-stream"
            self.reply(200, requested.read_bytes(), mime)
            return
        parts = path[len("/api/"):].strip("/").split("/")
        public_path = len(parts) == 3 and parts[0] == "projects" and parts[2] in {"intake", "clarify"}
        agent_path = len(parts) >= 4 and parts[0] == "projects" and parts[2] == "agent"
        if self.command == "OPTIONS" and public_path:
            with self.server.store.connect() as conn:
                self.widget_origin(project_row(conn, parts[1]))
            self.reply(204, b"")
            return
        if not public_path and not agent_path:
            self.operator()
        write = self.command in {"POST", "PATCH"}
        data = self.read_json() if write else {}
        if self.command == "POST" and len(parts) == 3 and (parts[0], parts[2]) in {("projects", "clarify"), ("tasks", "discuss")}:
            response = self.chat(parts, data)
        else:
            with self.server.store.connect(write=write) as conn:
                response = self.store_api(conn, parts, data)
        self.reply(200, response)

    def handle_method(self):
        try:
            self.dispatch()
        except ApiError as exc:
            self.reply(exc.status, {"error": str(exc)})
        except (ValueError, UnicodeError, RecursionError):
            self.reply(400, {"error": "Malformed request"})
        except sqlite3.OperationalError:
            self.reply(503, {"error": "Database operation unavailable"})

    do_GET = do_POST = do_PATCH = do_OPTIONS = do_HEAD = handle_method


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", type=Path, default=ROOT / "data" / "relaydesk.sqlite3")
    args = parser.parse_args()
    os.umask(0o077)
    args.db.parent.mkdir(parents=True, exist_ok=True)
    server = QueueServer((args.host, args.port), args.db, os.getenv("RELAYDESK_ADMIN_TOKEN", ""))
    print(f"Relaydesk listening on http://{args.host}:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
