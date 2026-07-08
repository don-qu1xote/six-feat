"""
session_crypto.py — Python mirror of src/auth/session_crypto.cpp
==================================================================

This is a faithful re-implementation of the AES-256-GCM session-cookie
format used by the C++ service (see src/auth/session_crypto.cpp), so that:

  1.  Test fixtures can mint a valid `six_feat_session` cookie without a
      real Genius OAuth round-trip (see conftest.py: `make_session_cookie`,
      `auth_cookie`, `client` fixtures).
  2.  tests/test_session_crypto.py can assert the wire format itself
      (nonce/ciphertext/tag layout, base64url alphabet, expiry handling,
      tamper detection) independently of whether the C++ binary is even
      built — these are pure-Python unit tests.

Wire format (must match session_crypto.cpp exactly):

    cookie_value = base64url_no_pad( nonce[12] || ciphertext || tag[16] )

    plaintext (JSON, minimal/handwritten — NOT a general JSON encoder,
    mirroring the C++ string-concatenation approach byte-for-byte). The
    tok/name values are JSON-escaped (via json.dumps) exactly like the C++
    JsonEscape() helper, so quotes/backslashes/control chars in an
    access_token or name can't break the format:

        {"tok":"<access_token>","exp":<unix_seconds>}
        {"tok":"<access_token>","exp":<unix_seconds>,"name":"<name>"}

Key derivation (mirrors auth::KeyFromEnv()):
    - APP_SECRET is exactly 64 hex chars  → use as raw 32 bytes directly
    - otherwise                            → SHA-256(APP_SECRET) → 32 bytes
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from dataclasses import dataclass
from typing import Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NONCE_LEN = 12
TAG_LEN = 16


def key_from_secret(app_secret: str) -> bytes:
    """Mirror of auth::KeyFromEnv() — derive the 32-byte AES key."""
    if not app_secret:
        raise ValueError("APP_SECRET must be non-empty")
    is_hex64 = len(app_secret) == 64 and all(
        c in "0123456789abcdefABCDEF" for c in app_secret
    )
    if is_hex64:
        return bytes.fromhex(app_secret)
    return hashlib.sha256(app_secret.encode("utf-8")).digest()


def _b64url_encode_nopad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode_nopad(s: str) -> bytes:
    # base64url alphabet validation mirrors B64CharVal: any character
    # outside [A-Za-z0-9-_] is invalid and must be rejected (not padded
    # away silently), matching the C++ decoder's all-or-nothing behaviour.
    valid_chars = set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    )
    if not s:
        return b""
    if any(c not in valid_chars for c in s):
        raise ValueError("invalid base64url character")
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


def _json_escape(s: str) -> str:
    """Mirror of the C++ JsonEscape() helper (uses json.dumps for the same
    backslash/quote/control-char escaping, then strips the surrounding
    quotes since we splice the result into a hand-built JSON string)."""
    return json.dumps(s)[1:-1]


def encrypt(access_token: str, expires_at_unix: int, key: bytes, name: str = "") -> str:
    """Mirror of auth::Encrypt(). Builds the same hand-rolled JSON shape."""
    if len(key) != 32:
        raise ValueError("key must be 32 bytes")

    plain = '{"tok":"' + _json_escape(access_token) + '","exp":' + str(int(expires_at_unix))
    if name:
        plain += ',"name":"' + _json_escape(name) + '"'
    plain += "}"

    nonce = os.urandom(NONCE_LEN)
    aesgcm = AESGCM(key)
    # cryptography's AESGCM.encrypt() appends the 16-byte tag to the
    # ciphertext already, matching the C++ nonce||ciphertext||tag layout.
    ct_and_tag = aesgcm.encrypt(nonce, plain.encode("utf-8"), None)
    payload = nonce + ct_and_tag
    return _b64url_encode_nopad(payload)


@dataclass
class SessionData:
    access_token: str
    expires_at_unix: int
    name: str = ""


def decrypt(cookie_value: str, key: bytes) -> Optional[SessionData]:
    """Mirror of auth::Decrypt(). Returns None on any failure, exactly
    like the C++ implementation (invalid base64, bad tag, expired)."""
    try:
        payload = _b64url_decode_nopad(cookie_value)
    except ValueError:
        return None

    if len(payload) < NONCE_LEN + 1 + TAG_LEN:
        return None

    nonce = payload[:NONCE_LEN]
    ct_and_tag = payload[NONCE_LEN:]

    try:
        aesgcm = AESGCM(key)
        plain = aesgcm.decrypt(nonce, ct_and_tag, None)
    except InvalidTag:
        return None
    except Exception:
        return None

    try:
        obj = json.loads(plain.decode("utf-8"))
    except Exception:
        # C++ JsonGetString/JsonGetInt degrade gracefully to "" / 0 on
        # malformed JSON rather than throwing; mirror that here too.
        obj = {}

    access_token = obj.get("tok", "") if isinstance(obj, dict) else ""
    expires_at = int(obj.get("exp", 0)) if isinstance(obj, dict) else 0
    name = obj.get("name", "") if isinstance(obj, dict) else ""

    if not access_token:
        return None

    if expires_at < int(time.time()):
        return None

    return SessionData(access_token=access_token, expires_at_unix=expires_at, name=name)


def make_cookie(
    app_secret: str,
    access_token: str = "test-genius-token",
    ttl_seconds: int = 3600,
    name: str = "Test User",
) -> str:
    """High-level convenience used by test fixtures: mint a fresh, valid
    `six_feat_session` cookie value for the given APP_SECRET."""
    key = key_from_secret(app_secret)
    exp = int(time.time()) + ttl_seconds
    return encrypt(access_token, exp, key, name=name)
