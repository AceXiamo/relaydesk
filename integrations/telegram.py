#!/usr/bin/env python3
"""Collect explicit /feedback messages from the configured Telegram groups."""
import hashlib
import json
import os
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    """Keep the Telegram token and RelayDesk bearer key on their original hosts."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


http = build_opener(NoRedirect())


class ServiceError(Exception):
    def __init__(self, service, status, retry_after=0):
        super().__init__(f"{service} request failed (status {status})")
        self.retry_after = retry_after


def post(service, url, payload, bearer=None, timeout=45):
    headers = {"Content-Type": "application/json"}
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    req = Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with http.open(req, timeout=timeout) as reply:
            return json.load(reply)
    except HTTPError as exc:
        delay = 0
        if exc.code == 429:
            try:
                delay = int(json.load(exc).get("parameters", {}).get("retry_after", 0))
            except (ValueError, TypeError, OSError):
                pass
        raise ServiceError(service, exc.code, delay) from None
    except (OSError, URLError, ValueError):
        # Exception URLs may contain the bot token. Log only the service name.
        raise ServiceError(service, "connection/response") from None


def required(name):
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"Missing {name}")
    return value


def config():
    base = required("RELAY_URL").rstrip("/")
    parsed = urlsplit(base)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("RELAY_URL must be a service URL")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Use HTTPS for a remote RelayDesk server")
    project = quote(required("RELAY_PROJECT"), safe="")
    chat_ids = {int(item.strip()) for item in required("TELEGRAM_CHAT_IDS").split(",")}
    if any(chat_id >= 0 for chat_id in chat_ids):
        raise ValueError("TELEGRAM_CHAT_IDS expects numeric group IDs (negative integers)")
    return (base + "/api/projects/" + project + "/intake", required("RELAY_BOT_KEY"),
            required("TELEGRAM_BOT_TOKEN"), chat_ids)


COMMAND = re.compile(r"^/feedback(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$", re.IGNORECASE)


def capture(message, chat_ids, username):
    """Return None for unrelated traffic, or (ticket, guidance) for a command."""
    chat = message.get("chat", {})
    if chat.get("type") not in {"group", "supergroup"} or chat.get("id") not in chat_ids:
        return None
    if message.get("from", {}).get("is_bot"):
        return None
    match = COMMAND.fullmatch(message.get("text", "").strip())
    if not match or (match[1] and match[1].casefold() != username.casefold()):
        return None
    note = (match[2] or "").strip()
    reply = message.get("reply_to_message", {})
    quoted = (reply.get("text") or reply.get("caption") or "").strip()
    if not (note or quoted):
        return None, "请在 /feedback 后写下问题，也可以回复一条文字消息并发送 /feedback。"

    target = reply if quoted else message
    main = quoted or note
    body = main
    if quoted and note:
        body += "\n\n补充说明\n" + note
    message_id = target["message_id"]
    # Stable across delivery retries and repeated capture of the same message.
    identity = f"{chat['id']}/{message_id}".encode()
    ticket = {
        "source": "bot",
        "title": main.splitlines()[0][:100],
        "body": body,
        "external_id": "telegram:" + hashlib.sha256(identity).hexdigest(),
    }
    if chat.get("username"):
        ticket["source_url"] = f"https://t.me/{quote(chat['username'], safe='')}/{message_id}"
    return ticket, None


def run(endpoint, key, token, chat_ids):
    def telegram(method, payload):
        response = post("Telegram", f"https://api.telegram.org/bot{token}/{method}", payload)
        if not response.get("ok"):
            raise ServiceError("Telegram", response.get("error_code"))
        return response["result"]

    offset, delay, username = 0, 1, None
    while True:
        try:
            if username is None:
                username = telegram("getMe", {})["username"]
                print(f"Listening as @{username} in {len(chat_ids)} configured group(s).", flush=True)
            updates = telegram("getUpdates", {"offset": offset, "limit": 50, "timeout": 30,
                                               "allowed_updates": ["message"]})
            for update in updates:
                message = update.get("message", {})
                captured = capture(message, chat_ids, username)
                if captured:
                    ticket, ack = captured
                    if ticket:
                        saved = post("RelayDesk", endpoint, ticket, key)
                        ack = f"已收录到项目反馈 #{saved['number']}。"
                    reply = {"chat_id": message["chat"]["id"], "text": ack, "reply_parameters": {
                        "message_id": message["message_id"], "allow_sending_without_reply": True}}
                    if message.get("is_topic_message"):
                        reply["message_thread_id"] = message["message_thread_id"]
                    try:
                        telegram("sendMessage", reply)
                    except ServiceError as err:
                        # A missing acknowledgement must not block later feedback.
                        print(f"Could not reply in group: {err}", file=sys.stderr, flush=True)
                offset = update["update_id"] + 1
            delay = 1
        except ServiceError as err:
            pause = max(delay, err.retry_after)
            print(f"{err}; retrying in {pause}s", file=sys.stderr, flush=True)
            time.sleep(pause)
            delay = min(60, delay * 2)


if __name__ == "__main__":
    try:
        run(*config())
    except ValueError as error:
        sys.exit(str(error))
    except KeyboardInterrupt:
        pass
