#!/usr/bin/env python3
"""Merge extracted source fields into a provenance-preserving config draft."""

import json
import sys
from collections import defaultdict
from pathlib import Path


REQUIRED_FIELDS = (
    "robotName",
    "role",
    "audience",
    "businessGoal",
    "openingLine",
    "voice",
    "asr",
)


def build_draft(sources: list) -> dict:
    candidates = defaultdict(list)
    for source in sources:
        source_id = source.get("sourceId")
        locator = source.get("locator")
        for field, value in source.get("fields", {}).items():
            if value is None or value == "":
                continue
            candidates[field].append(
                {"value": value, "sourceId": source_id, "locator": locator}
            )

    fields = {}
    conflicts = {}
    for field, items in candidates.items():
        distinct = []
        for item in items:
            if item["value"] not in distinct:
                distinct.append(item["value"])
        fields[field] = {
            "value": distinct[0] if len(distinct) == 1 else None,
            "sources": [
                {"sourceId": item["sourceId"], "locator": item["locator"]}
                for item in items
            ],
        }
        if len(distinct) > 1:
            conflicts[field] = [
                {
                    "value": value,
                    "sources": [
                        {"sourceId": item["sourceId"], "locator": item["locator"]}
                        for item in items
                        if item["value"] == value
                    ],
                }
                for value in distinct
            ]

    missing = [field for field in REQUIRED_FIELDS if field not in fields]
    return {
        "status": "ready_for_confirmation" if not conflicts and not missing else "needs_user_resolution",
        "fields": fields,
        "conflicts": conflicts,
        "missingFields": missing,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: build_config_draft.py <extracted-sources.json>", file=sys.stderr)
        return 2
    sources = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    payload = build_draft(sources)
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0 if payload["status"] == "ready_for_confirmation" else 2


if __name__ == "__main__":
    raise SystemExit(main())
