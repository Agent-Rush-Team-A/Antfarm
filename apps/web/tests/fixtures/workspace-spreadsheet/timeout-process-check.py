"""Independently require the timed-out shell and child to terminate within a bounded interval."""
import json
from pathlib import Path
import sys
import time


def check_processes(pid_file: Path, timeout_seconds: float) -> dict:
    """Read both target PIDs and inspect their Linux states without sending any signal."""
    fields = pid_file.read_text().split()
    if len(fields) != 2 or any(not field.isdecimal() for field in fields):
        raise ValueError("Expected the shell and child PIDs")
    pids = [int(field) for field in fields]
    if len(set(pids)) != 2 or any(pid <= 1 for pid in pids):
        raise ValueError("Expected two distinct process PIDs greater than one")
    if not 0 < timeout_seconds <= 5:
        raise ValueError("Process verification deadline must be within five seconds")
    started = time.monotonic()
    while True:
        living = []
        for pid in pids:
            try:
                stat = Path(f"/proc/{pid}/stat").read_text()
            except FileNotFoundError:
                continue
            state = stat.rsplit(")", 1)[1].split()[0]
            # Zombies have terminated and cannot execute; their parent still owns reaping.
            if state not in {"Z", "X"}:
                living.append({"pid": pid, "state": state})
        elapsed = time.monotonic() - started
        if not living:
            return {"verified": True, "pids": pids, "elapsedMs": round(elapsed * 1000, 3)}
        if elapsed >= timeout_seconds:
            raise RuntimeError(f"Timed-out processes are still alive: {json.dumps(living)}")
        time.sleep(min(0.05, timeout_seconds - elapsed))


if __name__ == "__main__":
    print(json.dumps(check_processes(Path(sys.argv[1]), float(sys.argv[2]))))
