from http.client import HTTPConnection
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest import TestCase
from unittest.mock import patch

from eth_account import Account
from eth_account.messages import encode_defunct

import github_repos
from server import QueueServer
from wallet_auth import WalletAuth


class AdminTest(TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.directory = Path(tmp.name)
        self.account = Account.create()
        self.wallet = WalletAuth(self.account.address, "https://desk.test")
        self.server = QueueServer(("127.0.0.1", 0), self.directory / "db", "old-password", wallet=self.wallet)
        self.addCleanup(self.server.server_close)
        thread = Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)
        self.cookie = ""

    def call(self, path, body=None, **headers):
        client = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            client.request("GET" if body is None else "POST", "/api/" + path,
                           None if body is None else json.dumps(body),
                           {"Host": "desk.test", "Origin": self.wallet.origin, "Cookie": self.cookie,
                            "Content-Type": "application/json", **headers})
            response = client.getresponse()
            return response.status, json.load(response), dict(response.headers)
        finally:
            client.close()

    def signed_challenge(self, account):
        status, challenge, _ = self.call("auth/challenge", {"chain_id": 1})
        self.assertEqual(status, 200)
        self.assertIn("URI: https://desk.test", challenge["message"])
        signature = account.sign_message(encode_defunct(text=challenge["message"])).signature
        return {"nonce": challenge["nonce"], "signature": "0x" + signature.hex()}

    def login(self):
        signed = self.signed_challenge(self.account)
        status, _, headers = self.call("auth/verify", signed)
        self.assertEqual(status, 200)
        cookie = headers["Set-Cookie"]
        for flag in ["__Host-", "Secure", "SameSite=Strict", "HttpOnly", "Path=/"]:
            self.assertIn(flag, cookie)
        self.cookie = cookie.split(";")[0]
        return signed

    def test_operator_session_lifecycle(self):
        self.assertEqual(self.call("projects", Authorization="Bearer old-password")[0], 401)
        self.assertEqual(self.call("auth/challenge", {"chain_id": 1}, Origin="https://other.test")[0], 403)
        signed = self.login()
        self.assertEqual(self.call("projects")[0], 200)
        self.assertEqual(self.call("auth/verify", signed)[0], 401)
        self.assertEqual(self.call("auth/logout", {})[0], 200)
        self.assertEqual(self.call("projects")[0], 401)

    def test_wrong_signer_and_expiration(self):
        self.assertEqual(self.call("auth/verify", self.signed_challenge(Account.create()))[0], 401)
        signed = self.signed_challenge(self.account)
        with patch("wallet_auth.time.monotonic", return_value=float("inf")):
            self.assertEqual(self.call("auth/verify", signed)[0], 401)
        self.login()
        with patch("wallet_auth.time.monotonic", return_value=float("inf")):
            self.assertEqual(self.call("projects")[0], 401)

    def test_github_connection(self):
        self.assertEqual(self.call("github")[0], 401)
        self.assertEqual(self.call("github/connect", {"token": "test_token"})[0], 401)
        self.login()
        self.assertFalse(self.call("github")[1]["configured"])
        fixture = {"repos": ["example/private"], "more": False}
        with patch("github_repos.repositories", return_value=fixture) as fetch:
            response = self.call("github/connect", {"token": "test_token"})
            self.assertEqual(response[1], {"configured": True})
            self.assertEqual(self.call("github/repos", {"page": 2})[1], fixture)
            fetch.assert_called_with("test_token", 2)
        path = self.directory / ".github-token"
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with patch("github_repos.repositories", side_effect=github_repos.GithubError("rejected")):
            self.assertEqual(self.call("github/connect", {"token": "invalid"})[0], 502)
        self.assertEqual(path.read_text(), "test_token")
        self.assertEqual(self.call("github/disconnect", {})[0], 200)
        self.assertFalse(path.exists())
        self.assertEqual(self.call("github/repos", {})[0], 409)
