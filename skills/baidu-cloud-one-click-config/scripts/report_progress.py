#!/usr/bin/env python3
"""Report a real Codex execution to the Auto UX control plane without leaking inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

VALID_STEPS = (
    "source.parse", "draft.confirm", "environment.preflight", "robot.create",
    "field.configure", "voice.preflight", "publish.confirm", "publish.verify",
    "numbers.confirm", "dial.confirm", "dial.verify", "complete",
)
VALID_PHASES = (
    "source_parse", "draft_confirm", "environment_preflight", "robot_create",
    "field_configure", "voice_preflight", "publish_confirm", "publish_verify",
    "numbers_confirm", "dial_confirm", "call_verify", "complete",
)


class ControlPlaneError(RuntimeError):
    def __init__(self, status: int, code: str, details=None):
        self.status = status
        self.code = code
        self.details = details
        super().__init__(f"control plane HTTP {status}: {code}")


def request_json(state: dict, method: str, path: str, payload: Optional[dict] = None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        state["apiBaseUrl"].rstrip("/") + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {state['agentToken']}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read()
            return None if not raw else json.loads(raw)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {}
        raise ControlPlaneError(
            error.code,
            parsed.get("code", "CONTROL_PLANE_ERROR"),
            parsed.get("details"),
        ) from error


def manifest(state: dict) -> dict:
    return {
        "pluginVersion": "2.1.0", "contractVersion": "2",
        "capabilities": {
            "feishuCli": True,
            "baiduApi": True,
            "browserFallback": True,
        },
        "agentId": state["agentId"], "sessionId": state["sessionId"],
        "executionId": state["executionId"],
    }


def claim(state: dict):
    return request_json(
        state,
        "POST",
        f"/api/executions/{urllib.parse.quote(state['executionId'], safe='')}/agent/claim",
        manifest(state),
    )


def renew_agent_lock(state: dict) -> None:
    execution = urllib.parse.quote(state["executionId"], safe="")
    try:
        request_json(state, "POST", f"/api/executions/{execution}/agent/heartbeat", {
            "agentId": state["agentId"], "sessionId": state["sessionId"]
        })
    except ControlPlaneError as error:
        if error.code != "EXECUTION_LOCK_MISMATCH":
            raise
        claim(state)


def load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(path: str, value: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    target.chmod(0o600)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def checkpoint_event(state: dict, step: str, status: str, phase: str, attempt: int) -> dict:
    fingerprint = hashlib.sha256(f"{state['executionId']}:{step}:{attempt}".encode()).hexdigest()
    return {
        "executionId": state["executionId"],
        "stepId": step,
        "attempt": attempt,
        "status": status,
        "occurredAt": now(),
        "inputHash": f"sha256:{fingerprint}",
        "evidence": {
            "kind": "checkpoint",
            "summary": {"phase": phase, "status": status},
            "reference": {"kind": "checkpoint", "id": f"checkpoint:{fingerprint[:24]}"},
        },
        "nextAction": "wait_for_user" if status == "waiting_confirmation" else "stop",
    }


def call_record_event(state: dict, status: str, outcome: str, record_path: str, attempt: int) -> dict:
    payload = load(record_path)
    items = payload.get("items") or []
    if len(items) != 1:
        raise RuntimeError("call evidence must contain exactly one task-filtered item")
    item = items[0]
    safe_fields = (
        "isRobotHangup", "completeType", "durationTimeLen", "ringingTimeLen",
        "talkingTimeLen", "talkingTurn", "sipCode", "sipInfo", "action",
    )
    summary = {"outcome": outcome}
    summary.update({key: item[key] for key in safe_fields if item.get(key) is not None})
    identity = f"{state['executionId']}:{item.get('sessionId', '')}:{attempt}"
    fingerprint = hashlib.sha256(identity.encode()).hexdigest()
    return {
        "executionId": state["executionId"],
        "stepId": "dial.verify",
        "attempt": attempt,
        "status": status,
        "occurredAt": now(),
        "inputHash": f"sha256:{fingerprint}",
        "evidence": {
            "kind": "platform_record",
            "summary": summary,
            "reference": {
                "kind": "platform_record",
                "id": f"platform_record:{fingerprint[:24]}",
            },
        },
        "nextAction": "inspect_call_record" if status in ("failed", "unknown") else "stop",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("state")
    init.add_argument("api_base_url")
    init.add_argument("execution_id")
    init.add_argument("agent_token")
    event = commands.add_parser("event")
    event.add_argument("state")
    event.add_argument("step", choices=VALID_STEPS)
    event.add_argument("status")
    event.add_argument("phase", choices=VALID_PHASES)
    event.add_argument("--attempt", type=int, default=1)
    event.add_argument("--confirmed-action", choices=["publish", "import_numbers", "start_dial"])
    call_event = commands.add_parser("call-event")
    call_event.add_argument("state")
    call_event.add_argument("status", choices=["succeeded", "failed", "unknown"])
    call_event.add_argument(
        "outcome",
        choices=[
            "unavailable", "recorded", "ringing", "connected", "no_answer",
            "busy", "failed", "robot_hangup_incomplete",
        ],
    )
    call_event.add_argument("record")
    call_event.add_argument("--attempt", type=int, default=1)
    heartbeat = commands.add_parser("heartbeat")
    heartbeat.add_argument("state")
    wait = commands.add_parser("wait-confirmation")
    wait.add_argument("state")
    wait.add_argument("action", choices=["publish", "import_numbers", "start_dial"])
    wait.add_argument("--timeout", type=int, default=3600)
    decide = commands.add_parser("decide")
    decide.add_argument("state")
    decide.add_argument("action", choices=["publish", "import_numbers", "start_dial"])
    decide.add_argument("decision", choices=["approved", "rejected"])
    args = parser.parse_args()

    if args.command == "init":
        state = {
            "apiBaseUrl": args.api_base_url.rstrip("/"),
            "executionId": args.execution_id,
            "agentToken": args.agent_token,
            "agentId": "MacCodex",
            "sessionId": f"Session_{secrets.token_hex(12)}",
        }
        claimed = claim(state)
        if not claimed:
            raise RuntimeError("control plane returned an empty claim")
        save(args.state, state)
        print("claimed")
        return

    state = load(args.state)
    execution = urllib.parse.quote(state["executionId"], safe="")
    if args.command == "heartbeat":
        renew_agent_lock(state)
        print("renewed")
    elif args.command == "event":
        renew_agent_lock(state)
        payload = {
            "agentId": state["agentId"], "sessionId": state["sessionId"],
            "event": checkpoint_event(state, args.step, args.status, args.phase, args.attempt),
        }
        if args.confirmed_action:
            confirmation = state.get("confirmations", {}).get(args.confirmed_action)
            if not confirmation or confirmation.get("decision") != "approved":
                raise RuntimeError("approved confirmation was not recorded locally")
            payload["localConfirmation"] = {
                "source": "local_codex", "action": args.confirmed_action,
                "confirmedAt": confirmation["decidedAt"],
                "stateHash": "sha256:" + hashlib.sha256(
                    f"{state['executionId']}:{args.confirmed_action}:{time.time_ns()}".encode()
                ).hexdigest(),
            }
        request_json(state, "POST", f"/api/executions/{execution}/events", payload)
        print("reported")
    elif args.command == "call-event":
        renew_agent_lock(state)
        payload = {
            "agentId": state["agentId"], "sessionId": state["sessionId"],
            "event": call_record_event(
                state, args.status, args.outcome, args.record, args.attempt
            ),
        }
        request_json(state, "POST", f"/api/executions/{execution}/events", payload)
        print("reported")
    elif args.command == "decide":
        result = request_json(state, "POST", f"/api/executions/{execution}/decision", {
            "action": args.action, "decision": args.decision
        })
        state.setdefault("confirmations", {})[args.action] = result
        save(args.state, state)
        print(result["decision"])
    elif args.command == "wait-confirmation":
        deadline = time.monotonic() + args.timeout
        next_heartbeat = 0.0
        query = urllib.parse.urlencode({"action": args.action})
        while time.monotonic() < deadline:
            if time.monotonic() >= next_heartbeat:
                renew_agent_lock(state)
                next_heartbeat = time.monotonic() + 30
            result = request_json(state, "GET", f"/api/executions/{execution}/decision?{query}")
            if result:
                state.setdefault("confirmations", {})[args.action] = result
                save(args.state, state)
                print(result["decision"])
                return
            time.sleep(3)
        raise RuntimeError("confirmation wait timed out")


if __name__ == "__main__":
    main()
