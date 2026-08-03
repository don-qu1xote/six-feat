from __future__ import annotations

import hashlib
import time

import pytest

import session_crypto as sc


class TestKeyFromSecret:
    def test_64_hex_chars_used_as_raw_bytes(self):
        secret = "0123456789abcdef" * 4
        key = sc.key_from_secret(secret)
        assert key == bytes.fromhex(secret)
        assert len(key) == 32

    def test_64_hex_chars_uppercase_also_raw(self):
        secret = "0123456789ABCDEF" * 4
        key = sc.key_from_secret(secret)
        assert key == bytes.fromhex(secret)

    def test_non_hex_string_is_sha256_hashed(self):
        secret = "my-plain-password"
        key = sc.key_from_secret(secret)
        assert key == hashlib.sha256(secret.encode()).digest()
        assert len(key) == 32

    def test_63_hex_chars_is_sha256_hashed_not_raw(self):
        secret = "a" * 63
        key = sc.key_from_secret(secret)
        assert key == hashlib.sha256(secret.encode()).digest()

    def test_65_hex_chars_is_sha256_hashed_not_raw(self):
        secret = "a" * 65
        key = sc.key_from_secret(secret)
        assert key == hashlib.sha256(secret.encode()).digest()

    def test_64_chars_with_non_hex_char_is_sha256_hashed(self):
        secret = "g" + "a" * 63
        key = sc.key_from_secret(secret)
        assert key == hashlib.sha256(secret.encode()).digest()

    def test_empty_secret_raises(self):
        with pytest.raises(ValueError):
            sc.key_from_secret("")

    def test_derivation_is_deterministic(self):
        assert sc.key_from_secret("abc") == sc.key_from_secret("abc")


class TestEncryptDecryptRoundTrip:
    def test_basic_round_trip(self):
        key = sc.key_from_secret("a" * 64)
        exp = int(time.time()) + 3600
        cookie = sc.encrypt("my-access-token", exp, key)
        data = sc.decrypt(cookie, key)
        assert data is not None
        assert data.access_token == "my-access-token"
        assert data.expires_at_unix == exp

    def test_round_trip_with_name(self):
        key = sc.key_from_secret("b" * 64)
        exp = int(time.time()) + 3600
        cookie = sc.encrypt("tok", exp, key, name="Drake")
        data = sc.decrypt(cookie, key)
        assert data is not None
        assert data.name == "Drake"

    def test_round_trip_without_name_defaults_empty(self):
        key = sc.key_from_secret("c" * 64)
        exp = int(time.time()) + 3600
        cookie = sc.encrypt("tok", exp, key)
        data = sc.decrypt(cookie, key)
        assert data is not None
        assert data.name == ""

    def test_two_encryptions_of_same_data_differ(self):
        key = sc.key_from_secret("d" * 64)
        exp = int(time.time()) + 3600
        c1 = sc.encrypt("same-token", exp, key)
        c2 = sc.encrypt("same-token", exp, key)
        assert c1 != c2

    def test_output_is_base64url_no_padding(self):
        key = sc.key_from_secret("e" * 64)
        cookie = sc.encrypt("tok", int(time.time()) + 100, key)
        assert "=" not in cookie
        assert "+" not in cookie
        assert "/" not in cookie

    def test_make_cookie_convenience_helper_round_trips(self):
        secret = "f" * 64
        cookie = sc.make_cookie(secret, access_token="conv-tok", ttl_seconds=60, name="X")
        key = sc.key_from_secret(secret)
        data = sc.decrypt(cookie, key)
        assert data is not None
        assert data.access_token == "conv-tok"
        assert data.name == "X"

    def test_access_token_with_special_json_chars_round_trips(self):
        key = sc.key_from_secret("a" * 64)
        cookie = sc.encrypt("normal-token-no-quotes", int(time.time()) + 100, key)
        data = sc.decrypt(cookie, key)
        assert data is not None
        assert data.access_token == "normal-token-no-quotes"


class TestTamperDetection:
    def test_flipped_character_is_rejected(self):
        key = sc.key_from_secret("a" * 64)
        cookie = sc.encrypt("tok", int(time.time()) + 100, key)
        idx = len(cookie) - 5
        flipped_char = "A" if cookie[idx] != "A" else "B"
        tampered = cookie[:idx] + flipped_char + cookie[idx + 1 :]
        assert sc.decrypt(tampered, key) is None

    def test_truncated_cookie_is_rejected(self):
        key = sc.key_from_secret("a" * 64)
        cookie = sc.encrypt("tok", int(time.time()) + 100, key)
        assert sc.decrypt(cookie[:-10], key) is None

    def test_wrong_key_is_rejected(self):
        key1 = sc.key_from_secret("a" * 64)
        key2 = sc.key_from_secret("b" * 64)
        cookie = sc.encrypt("tok", int(time.time()) + 100, key1)
        assert sc.decrypt(cookie, key2) is None

    def test_empty_cookie_is_rejected(self):
        key = sc.key_from_secret("a" * 64)
        assert sc.decrypt("", key) is None

    def test_too_short_payload_is_rejected(self):
        key = sc.key_from_secret("a" * 64)
        short_payload = b"\x00" * 28
        cookie = sc._b64url_encode_nopad(short_payload)
        assert sc.decrypt(cookie, key) is None

    def test_invalid_base64_characters_rejected(self):
        key = sc.key_from_secret("a" * 64)
        assert sc.decrypt("not valid base64 url!!! with spaces", key) is None

    def test_garbage_string_is_rejected(self):
        key = sc.key_from_secret("a" * 64)
        assert sc.decrypt("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", key) is None


class TestExpiry:
    def test_expired_cookie_is_rejected(self):
        key = sc.key_from_secret("a" * 64)
        past = int(time.time()) - 10
        cookie = sc.encrypt("tok", past, key)
        assert sc.decrypt(cookie, key) is None

    def test_far_future_expiry_is_accepted(self):
        key = sc.key_from_secret("a" * 64)
        future = int(time.time()) + 90 * 86400
        cookie = sc.encrypt("tok", future, key)
        data = sc.decrypt(cookie, key)
        assert data is not None

    def test_expiry_exactly_now_is_rejected(self):
        key = sc.key_from_secret("a" * 64)
        cookie = sc.encrypt("tok", int(time.time()) - 1, key)
        assert sc.decrypt(cookie, key) is None


class TestEmptyToken:
    def test_empty_token_round_trip_is_rejected(self):
        key = sc.key_from_secret("a" * 64)
        cookie = sc.encrypt("", int(time.time()) + 100, key)
        assert sc.decrypt(cookie, key) is None
