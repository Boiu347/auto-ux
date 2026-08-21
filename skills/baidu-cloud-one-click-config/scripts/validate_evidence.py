#!/usr/bin/env python3
"""Validate the minimum evidence needed before a workflow step may advance."""

import json
import sys
from pathlib import Path


REQUIRED = {
    "source.read": ("sourceId", "sourceHash"),
    "robot.create": ("target.robotId", "target.robotName", "requestId"),
    "field.write": (
        "target.robotId",
        "target.robotName",
        "requestId",
        "inputHash",
        "readbackHash",
    ),
    "publish.verify": ("target.robotId", "platformStatus", "evidenceRef"),
    "dial.submit": ("actionFingerprint", "confirmationRef", "submittedAt"),
    "dial.verify": ("platformRecordId", "outcome"),
}

REQUIRED_ANY = {
    "robot.create": ("target.platformId", "target.agentId"),
    "field.write": ("target.platformId", "target.agentId"),
}


def has_path(payload: dict, dotted_path: str) -> bool:
    current = payload
    for part in dotted_path.split("."):
        if not isinstance(current, dict) or current.get(part) in (None, ""):
            return False
        current = current[part]
    return True


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_evidence.py <evidence.json>", file=sys.stderr)
        return 2
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    step = payload.get("step")
    if step not in REQUIRED:
        print(json.dumps({"ok": False, "reason": "unknown_step"}, ensure_ascii=False))
        return 2
    missing = [path for path in REQUIRED[step] if not has_path(payload, path)]
    alternatives = REQUIRED_ANY.get(step)
    if alternatives and not any(has_path(payload, path) for path in alternatives):
        missing.append("|".join(alternatives))
    print(json.dumps({"ok": not missing, "missing": missing}, ensure_ascii=False, sort_keys=True))
    return 0 if not missing else 5


if __name__ == "__main__":
    raise SystemExit(main())
