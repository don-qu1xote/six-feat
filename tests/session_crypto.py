"""
session_crypto.py — Python-отражение src/auth/session_crypto.cpp
=================================================================

Точная перереализация формата session-cookie AES-256-GCM, используемого
C++ сервисом (см. src/auth/session_crypto.cpp), чтобы:

  1. Тестовые фикстуры могли создавать валидную `six_feat_session` cookie
     без реального Genius OAuth round-trip (см. conftest.py: `auth_cookie`,
     `client` фикстуры).
  2. tests/test_session_crypto.py мог проверять wire-формат (nonce/ciphertext
     layout, base64url, expiry, tamper detection) независимо от того,
     собран ли C++ бинарник.

Wire-формат (должен совпадать с session_crypto.cpp точно):

    cookie_value = base64url_no_pad( nonce[12] || ciphertext || tag[16] )

    plaintext (JSON, минимальный/ручной — НЕ общий JSON-encoder,
    зеркалирующий C++ подход конкатенации строк byte-for-byte). Значения
    tok/name экранируются через json.dumps, как и C++ JsonEscape(), чтобы
    кавычки/обратные слэши/control chars в access_token или name не
    сломали формат:

        {"tok":"<access_token>","exp":<unix_seconds>}
        {"tok":"<access_token>","exp":<unix_seconds>,"name":"<name>"}

Вывод ключа (зеркалирует auth::KeyFromEnv()):
    - APP_SECRET ровно 64 hex символа → используется как сырые 32 байта
    - иначе → SHA-256(APP_SECRET) → 32 байта
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
    """Отражение auth::KeyFromEnv() — вывод 32-байтного AES-ключа."""
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
    """Отражение C++ JsonEscape() (использует json.dumps для того же
    экранирования обратных слэшей/кавычек/control-char, затем обрезает
    окружающие кавычки, т.к. результат вставляется в ручную JSON-строку)."""
    return json.dumps(s)[1:-1]


def encrypt(access_token: str, expires_at_unix: int, key: bytes, name: str = "") -> str:
    """Отражение auth::Encrypt(). Строит ту же ручную JSON-структуру."""
    if len(key) != 32:
        raise ValueError("key must be 32 bytes")

    plain = '{"tok":"' + _json_escape(access_token) + '","exp":' + str(int(expires_at_unix))
    if name:
        plain += ',"name":"' + _json_escape(name) + '"'
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


def decrypt(cookie_value: str, key: bytes) -> Optional[SessionData]:
    """Отражение auth::Decrypt(). Возвращает None при любой ошибке,
    как и C++ реализация (невалидный base64, плохой tag, истекло)."""
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
    """Высокоуровневое удобство для тестовых фикстур: создать свежую,
    валидную `six_feat_session` cookie для данного APP_SECRET."""
    key = key_from_secret(app_secret)
    exp = int(time.time()) + ttl_seconds
    return encrypt(access_token, exp, key, name=name)
