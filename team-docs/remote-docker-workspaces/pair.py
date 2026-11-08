"""Start or stop one registered Antfarm Web/Runner pair from a Linux admin host."""

import argparse
import fcntl
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from uuid import UUID

HOST_CONTROL = "/srv/antfarm/source/team-docs/remote-docker-workspaces/host-control.sh"


def instance_settings(raw):
    instance_id = str(UUID(raw["id"]))
    alias = raw["ssh"]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", alias):
        raise ValueError("Invalid SSH host alias")
    return instance_id, raw["label"], alias


def observe(api, settings, region):
    instance_id, label, _ = settings
    state = api("GET", f"/instances/{instance_id}")["instance"]
    if (state["id"], state["label"], state["region"]) != (instance_id, label, region):
        raise ValueError(f"Instance identity does not match the deployment: {instance_id}")
    status = state["power_status"]
    if status not in ("running", "stopped"):
        raise ValueError(f"Instance power state is unconfirmed: {label}")
    return status


def power(api, settings, region, desired):
    if observe(api, settings, region) == desired:
        return
    action = {"running": "start", "stopped": "halt"}[desired]
    api("POST", f"/instances/{settings[0]}/{action}")
    deadline = time.monotonic() + 180
    while observe(api, settings, region) != desired:
        if time.monotonic() >= deadline:
            raise TimeoutError(f"{settings[1]} did not become {desired}")
        time.sleep(2)


def operate(action, config, api, remote):
    harness = instance_settings(config["harness"])
    runner = instance_settings(config["runner"])
    region = config["region"]
    deployment = config["deployment"]
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", deployment):
        raise ValueError("Invalid Runner deployment label")
    if any(harness[index] == runner[index] for index in range(3)):
        raise ValueError("Harness and Runner must identify separate hosts")
    harness_power = observe(api, harness, region)
    runner_power = observe(api, runner, region)
    if action == "start":
        power(api, runner, region, "running")
        remote(runner[2], "runner-start")
        power(api, harness, region, "running")
        remote(harness[2], "harness-start")
    else:
        if harness_power != "stopped":
            remote(harness[2], "harness-stop")
        if runner_power != "stopped":
            remote(runner[2], "runner-stop", deployment)
            power(api, runner, region, "stopped")
        power(api, harness, region, "stopped")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("action", choices=("start", "stop"))
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    api_key = Path(config["apiKeyFile"]).expanduser().read_text(encoding="utf-8").strip()
    if not api_key or any(char.isspace() for char in api_key):
        raise ValueError("Invalid Vultr API key file")

    def api(method, path):
        request = Request("https://api.vultr.com/v2" + path, method=method)
        request.add_unredirected_header("Authorization", f"Bearer {api_key}")
        if method == "POST":
            request.data = b"{}"
            request.add_header("Content-Type", "application/json")
        with urlopen(request, timeout=20) as response:
            payload = response.read()
        return json.loads(payload) if payload else None

    def remote(alias, *command):
        prefix = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                  "-o", "ConnectTimeout=5", alias]
        if command[0].endswith("-start"):
            deadline = time.monotonic() + 120
            while subprocess.run([*prefix, "true"], timeout=10).returncode != 0:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"SSH did not become ready on {alias}")
                time.sleep(2)
        subprocess.run([*prefix, "sudo", "-n", "/usr/bin/bash", HOST_CONTROL, *command],
                       timeout=180, check=True)

    with args.config.with_suffix(".lock").open("a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        operate(args.action, config, api, remote)
    print(f"Antfarm pair {args.action} confirmed")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        sys.exit(f"Antfarm pair: {error}")
