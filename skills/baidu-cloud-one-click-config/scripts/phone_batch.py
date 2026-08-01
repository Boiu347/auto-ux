#!/usr/bin/env python3
"""Validate a local phone list and print a privacy-safe JSON summary."""

import json
import re
import sys
from pathlib import Path


PHONE_RE = re.compile(r"^1[3-9]\d{9}$")


def normalize(raw: str) -> str:
    return re.sub(r"[\s-]", "", raw.strip())


def mask(phone: str) -> str:
    return f"{phone[:3]}****{phone[-4:]}"


def summarize(path: Path) -> dict:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    seen = set()
    masked = []
    invalid = []
    duplicate_count = 0

    for line_number, raw in enumerate(lines, start=1):
        phone = normalize(raw)
        if not PHONE_RE.fullmatch(phone):
            invalid.append({"line": line_number, "reason": "invalid_phone"})
            continue
        if phone in seen:
            duplicate_count += 1
            continue
        seen.add(phone)
        masked.append(mask(phone))

    return {
        "total": len(lines),
        "valid": len(seen),
        "invalid": invalid,
        "duplicates": duplicate_count,
        "maskedNumbers": masked,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: phone_batch.py <local-number-file>", file=sys.stderr)
        return 2
    print(json.dumps(summarize(Path(sys.argv[1])), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
