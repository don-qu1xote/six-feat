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
    if not app_secret:
        raise ValueError("APP_SECRET must be non-empty")
    is_hex64 = len(app_secret) == 64 and all(c in "0123456789abcdefABCDEF" for c in app_secret)
    if is_hex64:
        return bytes.fromhex(app_secret)
    return hashlib.sha256(app_secret.encode("utf-8")).digest()


def _b64url_encode_nopad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode_nopad(s: str) -> bytes:

    valid_chars = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    if not s:
        return b""
    if any(c not in valid_chars for c in s):
        raise ValueError("invalid base64url character")
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


def _json_escape(s: str) -> str:
    return json.dumps(s)[1:-1]


def encrypt(
    access_token: str,
    expires_at_unix: int,
    key: bytes,
    name: str = "",
    provider: str = "",
    provider_user_id: str = "",
) -> str:
    if len(key) != 32:
        raise ValueError("key must be 32 bytes")

    plain = '{"tok":"' + _json_escape(access_token) + '","exp":' + str(int(expires_at_unix))
    if name:
        plain += ',"name":"' + _json_escape(name) + '"'
    if provider:
        plain += ',"prov":"' + _json_escape(provider) + '"'
    if provider_user_id:
        plain += ',"uid":"' + _json_escape(provider_user_id) + '"'
    plain += "}"

    nonce = os.urandom(NONCE_LEN)
    aesgcm = AESGCM(key)

    ct_and_tag = aesgcm.encrypt(nonce, plain.encode("utf-8"), None)
    payload = nonce + ct_and_tag
    return _b64url_encode_nopad(payload)


@dataclass
class SessionData:
    access_token: str
    expires_at_unix: int
    name: str = ""
    provider: str = ""
    provider_user_id: str = ""


def decrypt(cookie_value: str, key: bytes) -> Optional[SessionData]:
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
        obj = {}

    access_token = obj.get("tok", "") if isinstance(obj, dict) else ""
    expires_at = int(obj.get("exp", 0)) if isinstance(obj, dict) else 0
    name = obj.get("name", "") if isinstance(obj, dict) else ""
    provider = obj.get("prov", "") if isinstance(obj, dict) else ""
    provider_user_id = obj.get("uid", "") if isinstance(obj, dict) else ""

    if not access_token:
        return None

    if expires_at < int(time.time()):
        return None

    return SessionData(
        access_token=access_token,
        expires_at_unix=expires_at,
        name=name,
        provider=provider,
        provider_user_id=provider_user_id,
    )


def make_cookie(
    app_secret: str,
    access_token: str = "test-genius-token",
    ttl_seconds: int = 3600,
    name: str = "Test User",
    provider: str = "",
    provider_user_id: str = "",
) -> str:
    key = key_from_secret(app_secret)
    exp = int(time.time()) + ttl_seconds
    return encrypt(
        access_token,
        exp,
        key,
        name=name,
        provider=provider,
        provider_user_id=provider_user_id,
    )


def stable_user_id(value: str) -> int:
    h = 1469598103934665603
    for b in value.encode("utf-8"):
        h ^= b
        h = (h * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return h & 0x7FFFFFFFFFFFFFFF


def session_user_id(provider: str, provider_user_id: str, name: str = "") -> int:
    if not provider_user_id:
        return stable_user_id(name)
    return stable_user_id(f"{provider or 'genius'}:{provider_user_id}")
