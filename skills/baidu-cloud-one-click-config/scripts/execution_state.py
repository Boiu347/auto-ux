#!/usr/bin/env python3
"""Maintain local execution checkpoints and high-risk action gates."""

import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path


RISKY_ACTIONS = ("publish", "import_numbers", "start_dial")


def output(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, sort_keys=True)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def fingerprint(execution_id: str, step_id: str, input_hash: str) -> str:
    raw = f"{execution_id}\0{step_id}\0{input_hash}".encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: execution_state.py <command> <state-file> [args]", file=sys.stderr)
        return 2
    command, path = sys.argv[1], Path(sys.argv[2])

    if command == "init":
        if len(sys.argv) != 4:
            return output({"reason": "execution_id_required"}, 2)
        state = {
            "executionId": sys.argv[3],
            "confirmations": {action: "missing" for action in RISKY_ACTIONS},
            "actions": {},
            "attempts": {},
            "lastCheckpoint": None,
        }
        save(path, state)
        return output({"ok": True, "executionId": state["executionId"]})

    state = load(path)

    if command == "confirm":
        action = sys.argv[3]
        if action not in RISKY_ACTIONS:
            return output({"reason": "unknown_risky_action"}, 2)
        state["confirmations"][action] = "issued"
        save(path, state)
        return output({"ok": True, "action": action})

    if command == "authorize":
        action = sys.argv[3]
        status = state["confirmations"].get(action, "missing")
        if status == "missing":
            return output({"ok": False, "reason": "confirmation_required"}, 3)
        if status == "consumed":
            return output({"ok": False, "reason": "confirmation_consumed"}, 3)
        state["confirmations"][action] = "consumed"
        save(path, state)
        return output({"ok": True, "action": action})

    if command == "record":
        step_id, input_hash, status = sys.argv[3:6]
        action_id = fingerprint(state["executionId"], step_id, input_hash)
        previous = state["actions"].get(action_id)
        if previous in ("running", "succeeded"):
            return output({"ok": False, "reason": "duplicate_action", "fingerprint": action_id}, 4)
        state["actions"][action_id] = status
        if status == "succeeded":
            state["lastCheckpoint"] = step_id
        save(path, state)
        return output({"ok": True, "fingerprint": action_id, "status": status})

    if command == "attempt":
        step_id = sys.argv[3]
        attempt = state["attempts"].get(step_id, 0) + 1
        if attempt > 2:
            return output({"ok": False, "reason": "retry_budget_exhausted"}, 4)
        state["attempts"][step_id] = attempt
        save(path, state)
        return output({"ok": True, "attempt": attempt})

    return output({"reason": "unknown_command"}, 2)


if __name__ == "__main__":
    raise SystemExit(main())
