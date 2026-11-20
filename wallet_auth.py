"""Single-operator, off-chain Ethereum sign-in for a single Relaydesk process."""
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from http.cookies import CookieError, SimpleCookie
import re
import secrets
from threading import Lock
import time
from urllib.parse import urlsplit

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import is_address, to_checksum_address

COOKIE = "__Host-relaydesk"
CHALLENGE_TTL = 300
SESSION_TTL = 12 * 3600


def cookie_value(header):
    jar = SimpleCookie()
    try:
        jar.load(header or "")
    except CookieError:
        return ""
    return jar[COOKIE].value if COOKIE in jar else ""


def session_cookie(token):
    age = SESSION_TTL if token else 0
    return f"{COOKIE}={token}; Path=/; Max-Age={age}; Secure; HttpOnly; SameSite=Strict"


class WalletAuth:
    def __init__(self, address, origin):
        url = urlsplit(origin)
        if (not is_address(address) or url.scheme != "https" or not url.hostname
                or url.username is not None or url.password is not None
                or origin != f"https://{url.netloc}"):
            raise ValueError("Set a valid RELAYDESK_ADMIN_WALLET and HTTPS RELAYDESK_ORIGIN")
        self.address = to_checksum_address(address)
        self.origin = origin
        self.host = url.netloc
        self.pending = OrderedDict()
        self.sessions = OrderedDict()
        self.lock = Lock()

    def challenge(self, chain):
        if type(chain) is not int or not 0 < chain < 2**53:
            raise ValueError("Invalid chain ID")
        nonce = secrets.token_hex(24)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        expires = now + timedelta(seconds=CHALLENGE_TTL)
        message = (f"{self.host} wants you to sign in with your Ethereum account:\n{self.address}\n\n"
                   "Sign in to the Relaydesk admin console.\n\n"
                   f"URI: {self.origin}\nVersion: 1\nChain ID: {chain}\nNonce: {nonce}\n"
                   f"Issued At: {now.isoformat()}\nExpiration Time: {expires.isoformat()}")
        with self.lock:
            if len(self.pending) >= 1024:
                self.pending.popitem(last=False)
            self.pending[nonce] = (time.monotonic() + CHALLENGE_TTL, message)
        return {"address": self.address, "nonce": nonce, "message": message}

    def verify(self, nonce, signature):
        with self.lock:
            challenge = self.pending.pop(nonce, None)
        if (not challenge or challenge[0] <= time.monotonic()
                or not re.fullmatch(r"0x[0-9a-fA-F]{130}", signature)):
            return None
        from eth_keys.exceptions import BadSignature
        try:
            signer = Account.recover_message(encode_defunct(text=challenge[1]), signature=signature)
        except (ValueError, BadSignature):
            return None
        if signer != self.address:
            return None
        token = secrets.token_urlsafe(32)
        with self.lock:
            if len(self.sessions) >= 128:
                self.sessions.popitem(last=False)
            self.sessions[token] = time.monotonic() + SESSION_TTL
        return token

    def authenticated(self, token):
        with self.lock:
            return self.sessions.get(token, 0) > time.monotonic()

    def logout(self, token):
        with self.lock:
            self.sessions.pop(token, None)
