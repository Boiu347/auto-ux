#!/usr/bin/env python3
"""Store Baidu Keyue AK/SK in the macOS Keychain without shell-history leaks."""

from __future__ import annotations

import argparse
import json
import subprocess


SERVICES = {
    "accessKey": "baidu-keyue-access-key",
    "secretKey": "baidu-keyue-secret-key",
}


def run_security(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["security", *arguments], check=False, capture_output=True, text=True
        )
    except FileNotFoundError as error:
        raise RuntimeError("MACOS_KEYCHAIN_UNAVAILABLE") from error


def exists(service: str, account: str) -> bool:
    return run_security(
        ["find-generic-password", "-a", account, "-s", service]
    ).returncode == 0


def store_interactively(service: str, account: str, label: str) -> None:
    print(f"Enter {label} at the macOS Keychain prompt.")
    try:
        result = subprocess.run(
            [
                "security",
                "add-generic-password",
                "-U",
                "-a",
                account,
                "-s",
                service,
                "-w",
            ],
            check=False,
        )
    except FileNotFoundError as error:
        raise RuntimeError("MACOS_KEYCHAIN_UNAVAILABLE") from error
    if result.returncode != 0:
        raise RuntimeError("KEYCHAIN_WRITE_FAILED")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", default="default")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    commands.add_parser("set")
    delete = commands.add_parser("delete")
    delete.add_argument("--yes", action="store_true")
    args = parser.parse_args()

    try:
        if args.command == "status":
            print(
                json.dumps(
                    {
                        "accessKey": exists(SERVICES["accessKey"], args.account),
                        "secretKey": exists(SERVICES["secretKey"], args.account),
                    },
                    sort_keys=True,
                )
            )
            return 0
        if args.command == "set":
            store_interactively(SERVICES["accessKey"], args.account, "Baidu Keyue Access Key")
            store_interactively(SERVICES["secretKey"], args.account, "Baidu Keyue Secret Key")
            print(json.dumps({"ok": True, "account": args.account}))
            return 0
        if not args.yes:
            print(json.dumps({"ok": False, "errorCode": "CONFIRMATION_REQUIRED"}))
            return 3
        for service in SERVICES.values():
            run_security(
                ["delete-generic-password", "-a", args.account, "-s", service]
            )
        print(json.dumps({"ok": True, "deleted": True, "account": args.account}))
        return 0
    except RuntimeError as error:
        print(json.dumps({"ok": False, "errorCode": str(error)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
