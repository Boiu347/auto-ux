#!/usr/bin/env python3
"""Safe local client for the Baidu Keyue outbound-call API."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Optional


BASE_URL = "https://aiob-open.baidu.com"
TOKEN_PATH = "/api/v2/getToken"
PHONE_PATTERN = re.compile(r"(?<!\d)(1\d{10}|0\d{9,11})(?!\d)")
SENSITIVE_KEYS = {
    "accesskey",
    "secretkey",
    "accesstoken",
    "authorization",
    "token",
    "nlutoken",
    "bottoken",
    "apikey",
    "record",
    "contexttext",
    "content",
}


class BaiduApiError(RuntimeError):
    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(code if not message else f"{code}: {message}")
        self.code = code


def mask_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) < 7:
        return "***"
    return f"{digits[:3]}{'*' * max(4, len(digits) - 7)}{digits[-4:]}"


def sanitize(value):
    if isinstance(value, dict):
        cleaned = {}
        for key, item in value.items():
            normalized = key.lower().replace("_", "")
            if normalized in SENSITIVE_KEYS:
                cleaned[key] = "[REDACTED]"
            elif normalized in {"mobile", "callernum", "didnumber", "servicenumber"}:
                cleaned[key] = mask_phone(str(item)) if item else item
            else:
                cleaned[key] = sanitize(item)
        return cleaned
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        return PHONE_PATTERN.sub(lambda match: mask_phone(match.group(0)), value)
    return value


def load_json_file(path: str) -> dict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise BaiduApiError("INVALID_INPUT", "JSON root must be an object")
    return payload


def _keychain_value(service: str, account: str) -> Optional[str]:
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-a", account, "-s", service, "-w"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def load_credentials(account: str = "default") -> tuple[str, str]:
    access_key = os.environ.get("BAIDU_KY_ACCESS_KEY") or _keychain_value(
        "baidu-keyue-access-key", account
    )
    secret_key = os.environ.get("BAIDU_KY_SECRET_KEY") or _keychain_value(
        "baidu-keyue-secret-key", account
    )
    if not access_key or not secret_key:
        raise BaiduApiError(
            "BAIDU_CREDENTIALS_MISSING",
            "set BAIDU_KY_ACCESS_KEY/BAIDU_KY_SECRET_KEY or the macOS Keychain entries",
        )
    if any(char in access_key + secret_key for char in "\r\n\0"):
        raise BaiduApiError("BAIDU_CREDENTIALS_INVALID")
    return access_key, secret_key


def default_token_cache() -> Path:
    configured = os.environ.get("BAIDU_KY_TOKEN_CACHE")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "Library" / "Caches" / "baidu-keyue" / "access-token.json"


class BaiduApiClient:
    def __init__(
        self,
        access_key: str,
        secret_key: str,
        token_cache: Optional[Path] = None,
        opener: Callable = urllib.request.urlopen,
        now: Callable[[], float] = time.time,
        timeout: int = 20,
    ) -> None:
        self.access_key = access_key
        self.secret_key = secret_key
        self.token_cache = token_cache
        self.opener = opener
        self.now = now
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        payload: Optional[dict] = None,
        params: Optional[dict] = None,
        *,
        retry_safe: bool = False,
    ) -> dict:
        if not path.startswith("/api/") or "://" in path:
            raise BaiduApiError("BAIDU_ENDPOINT_NOT_ALLOWED")
        query = urllib.parse.urlencode(params or {}, doseq=True)
        url = BASE_URL + path + (f"?{query}" if query else "")
        token = self.get_token()
        return self._request_json(
            method,
            url,
            payload,
            {"Authorization": token},
            retry_safe=retry_safe,
            mutation=method.upper() != "GET" and not retry_safe,
        )

    def get_token(self) -> str:
        cached = self._load_cached_token()
        if cached:
            return cached
        response = self._request_json(
            "POST",
            BASE_URL + TOKEN_PATH,
            {"accessKey": self.access_key, "secretKey": self.secret_key},
            {},
            retry_safe=True,
            mutation=False,
        )
        data = response.get("data") or {}
        token = data.get("accessToken")
        expires_minutes = data.get("expiresTime")
        if not token or not isinstance(expires_minutes, (int, float)):
            raise BaiduApiError("BAIDU_TOKEN_RESPONSE_INVALID")
        self._save_cached_token(token, float(expires_minutes))
        return token

    def _request_json(
        self,
        method: str,
        url: str,
        payload: Optional[dict],
        headers: dict,
        *,
        retry_safe: bool,
        mutation: bool,
    ) -> dict:
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if data is not None else {}),
                **headers,
            },
        )
        attempts = 2 if retry_safe else 1
        for attempt in range(attempts):
            try:
                with self.opener(request, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise BaiduApiError("BAIDU_RESPONSE_INVALID")
                if result.get("code") != 200:
                    raise BaiduApiError(
                        "BAIDU_API_REJECTED", str(result.get("msg") or "unknown error")[:200]
                    )
                return result
            except BaiduApiError:
                raise
            except urllib.error.HTTPError as error:
                if error.code in (401, 403):
                    raise BaiduApiError("BAIDU_AUTH_REJECTED") from error
                if error.code == 429:
                    raise BaiduApiError("BAIDU_RATE_LIMITED") from error
                raise BaiduApiError("BAIDU_HTTP_ERROR", str(error.code)) from error
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                if attempt + 1 < attempts:
                    continue
                code = "BAIDU_MUTATION_OUTCOME_UNKNOWN" if mutation else "BAIDU_NETWORK_ERROR"
                raise BaiduApiError(code) from error
        raise AssertionError("unreachable")

    def _cache_fingerprint(self) -> str:
        return hashlib.sha256(self.access_key.encode("utf-8")).hexdigest()

    def _load_cached_token(self) -> Optional[str]:
        if not self.token_cache or not self.token_cache.exists():
            return None
        try:
            cached = json.loads(self.token_cache.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if cached.get("accessKeyFingerprint") != self._cache_fingerprint():
            return None
        if float(cached.get("expiresAt", 0)) <= self.now() + 300:
            return None
        token = cached.get("accessToken")
        return token if isinstance(token, str) and token else None

    def _save_cached_token(self, token: str, expires_minutes: float) -> None:
        if not self.token_cache:
            return
        self.token_cache.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "accessKeyFingerprint": self._cache_fingerprint(),
            "accessToken": token,
            "expiresAt": self.now() + expires_minutes * 60,
        }
        temporary = self.token_cache.with_suffix(self.token_cache.suffix + ".tmp")
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, self.token_cache)
        self.token_cache.chmod(0o600)


def client_from_local_credentials(account: str = "default") -> BaiduApiClient:
    access_key, secret_key = load_credentials(account)
    return BaiduApiClient(access_key, secret_key, default_token_cache())


def print_result(payload: dict) -> None:
    print(json.dumps(sanitize(payload), ensure_ascii=False, sort_keys=True))
