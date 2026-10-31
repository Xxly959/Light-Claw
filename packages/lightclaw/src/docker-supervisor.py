"""Per-exec POSIX supervisor. stdin heartbeats bind the task to its host owner."""
import ctypes
import fcntl
import json
import os
import pathlib
import select
import signal
import subprocess
import sys
import time

mode, identity, root_name = sys.argv[1:4]
if len(identity) != 36 or any(c not in "0123456789abcdef-" for c in identity):
    raise ValueError("invalid task identity")
root = pathlib.Path(root_name) / identity
root.mkdir(parents=True, exist_ok=True, mode=0o700)
cancelled = root / "cancel"
state_path = root / "state.json"


def state():
    try:
        return json.loads(state_path.read_text())
    except FileNotFoundError:
        return {}


def save(value):
    temporary = root / f"state-{os.getpid()}.tmp"
    temporary.write_text(json.dumps(value))
    temporary.replace(state_path)


def process_table():
    table = {}
    for proc in pathlib.Path("/proc").glob("[0-9]*"):
        try:
            data = (proc / "stat").read_text().split(") ", 1)[1].split()
            table[int(proc.name)] = (int(data[1]), data[0], data[19])
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return table


def members(pgid):
    found = []
    if pathlib.Path("/proc").is_dir():
        table = process_table()
        current = state()
        supervisor = current.get("supervisor")
        owner = table.get(supervisor)
        if supervisor and (not owner or owner[2] != current.get("birth")):
            if current.get("status") != "stopped":
                raise RuntimeError("supervisor identity lost; descendant exit cannot be confirmed")
        tree = {supervisor} if owner and owner[2] == current.get("birth") else set()
        while True:
            descendants = {pid for pid, (parent, _, _) in table.items() if parent in tree}
            if descendants <= tree:
                break
            tree |= descendants
        for pid, (_, status, _) in table.items():
            if status == "Z" or pid == supervisor:
                continue
            tagged = False
            try:
                tagged = f"LIGHTCLAW_TASK_ID={identity}".encode() in pathlib.Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
            if pid in tree or tagged:
                found.append((pid, table[pid][2]))
    elif pgid and state().get("status") != "stopped":
        # Offline POSIX fallback. Linux uses a subreaper + ancestry, even for tag-cleared daemons.
        for line in subprocess.check_output(["ps", "-axo", "pid=,pgid=,stat="], text=True).splitlines():
            pid, group, status = line.split()
            if int(group) == pgid and not status.startswith("Z"):
                found.append((int(pid), None))
    return found


def stop(pgid):
    deadline = time.monotonic() + 3
    while True:
        alive = members(pgid)
        if not alive:
            return
        for pid, birth in alive:
            try:
                if birth is not None:
                    descriptor = os.pidfd_open(pid)
                    try:
                        if process_table().get(pid, (0, "", None))[2] == birth:
                            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                    finally:
                        os.close(descriptor)
                else:
                    os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            raise RuntimeError("task exit unconfirmed")
        time.sleep(0.025)


if mode == "cancel":
    with (root / "guard").open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        cancelled.touch(exist_ok=True)
        current = state()
    if current.get("status") != "stopped":
        stop(current.get("pgid"))
    # Tombstone prevents a delayed docker exec from launching after confirmation.
    print("STOPPED", flush=True)
elif mode == "run":
    timeout, command = float(sys.argv[4]), sys.argv[5]
    if pathlib.Path("/proc").is_dir():
        if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
            raise RuntimeError("Linux pidfd support required for safe cancellation")
        # Reparent double-forked / setsid / tag-cleared descendants to this supervisor.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise RuntimeError("Linux child subreaper unavailable")
    birth = process_table().get(os.getpid(), (0, "", None))[2]
    with (root / "guard").open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if cancelled.exists():
            sys.exit(125)
        save({"id": identity, "status": "starting"})
        env = dict(os.environ, LIGHTCLAW_TASK_ID=identity)
        child = subprocess.Popen(["sh", "-c", command], start_new_session=True, env=env)
        save({"id": identity, "status": "running", "pgid": child.pid, "supervisor": os.getpid(), "birth": birth})
    started = last_heartbeat = time.monotonic()
    reason = "completed"
    def interrupted(_signal, _frame):
        cancelled.touch(exist_ok=True)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        while child.poll() is None:
            now = time.monotonic()
            if cancelled.exists():
                reason = "cancelled"
                break
            if now - started >= timeout:
                reason = "timeout"
                break
            if now - last_heartbeat >= 1.5:
                reason = "host_lost"
                break
            ready, _, _ = select.select([sys.stdin.buffer], [], [], 0.1)
            if ready:
                if not os.read(sys.stdin.fileno(), 4096):
                    reason = "host_lost"
                    break
                last_heartbeat = time.monotonic()
    finally:
        # Also stop background children after their shell exits normally.
        stop(child.pid)
        child.wait()
        save({"id": identity, "status": "stopped", "pgid": child.pid, "reason": reason, "code": child.returncode})
    sys.exit(child.returncode if reason == "completed" and child.returncode >= 0 else 124)
else:
    raise ValueError("unknown supervisor mode")
