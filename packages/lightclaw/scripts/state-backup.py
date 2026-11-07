"""Offline single-instance state backup/restore. Never copy credentials or follow links."""
import argparse, contextlib, fcntl, hashlib, json, os, pathlib, shutil, stat, sys

@contextlib.contextmanager
def locked(control):
    control = pathlib.Path(control)
    control.mkdir(parents=True, exist_ok=True)
    fd = os.open(control / "instance.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError("invalid instance lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally: os.close(fd)

def root(value):
    path = pathlib.Path(value).absolute()
    if sys.platform == "darwin":
        for alias in ("/var/", "/tmp/"):
            if str(path).startswith(alias): path = pathlib.Path("/private" + str(path)); break
    if path.is_symlink() or path.resolve() != path: raise ValueError("linked root refused")
    return path

def separate(a, b):
    if a == b or a in b.parents or b in a.parents: raise ValueError("roots must be disjoint")

def inventory(directory, prefix):
    files, excluded = [], []
    def fail_walk(error): raise error
    for current, dirs, names in os.walk(directory, followlinks=False, onerror=fail_walk):
        for name in list(dirs):
            path = pathlib.Path(current) / name
            if path.is_symlink(): raise ValueError("backup directory link refused")
            if name in (".ssh", ".aws", "node_modules"):
                dirs.remove(name); excluded.append(str(path.relative_to(directory)))
        for name in names:
            path = pathlib.Path(current) / name
            if name.startswith(".env") or name in ("auth.json", "instance.lock", "health.json") or path.suffix.lower() in (".pem", ".key", ".p12"):
                excluded.append(str(path.relative_to(directory))); continue
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError("non-regular/linked backup file refused")
            relative = prefix + "/" + path.relative_to(directory).as_posix()
            files.append((path, relative, info.st_mode & 0o777))
    return files, excluded

def safe_file(directory, relative):
    parts = pathlib.PurePosixPath(relative).parts
    if not parts or parts[0] not in ("workspace", "control") or any(p in (".", "..") for p in parts) or "\\" in relative:
        raise ValueError("unsafe backup path")
    path = directory
    for part in parts:
        path = path / part
        if path.is_symlink(): raise ValueError("backup link refused")
    if not path.is_file() or path.stat().st_nlink != 1: raise ValueError("invalid backup file")
    return path

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("backup", "restore", "verify"))
    parser.add_argument("--workspace"); parser.add_argument("--control"); parser.add_argument("--out"); parser.add_argument("--backup")
    args = parser.parse_args()
    if args.mode == "backup":
        work, control, output = root(args.workspace), root(args.control), root(args.out)
        if not work.is_dir() or not control.is_dir():
            raise ValueError("backup requires existing workspace and control directories")
        separate(work, control); separate(work, output); separate(control, output)
        if output.exists(): raise ValueError("fresh output required")
        with locked(control):
            files, excluded = [], {}
            for source, prefix in ((work, "workspace"), (control, "control")):
                rows, skipped = inventory(source, prefix); files += rows; excluded[prefix] = skipped
            needed = sum(path.stat().st_size for path, _, _ in files)
            if shutil.disk_usage(output.parent).free < needed + 16 * 1024 * 1024: raise ValueError("disk reserve exhausted")
            output.mkdir(mode=0o700)
            manifest = {"schema": 1, "originControl": str(control), "files": [], "excluded": excluded}
            for path, relative, mode in files:
                data = path.read_bytes(); destination = output / relative; destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with destination.open("xb") as f: f.write(data); f.flush(); os.fsync(f.fileno())
                destination.chmod(mode)
                manifest["files"].append({"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mode": mode})
            (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            print(json.dumps({"backup": str(output), "files": len(files), "credentials": "excluded"}))
        return
    backup = root(args.backup)
    manifest_path = backup / "manifest.json"
    if manifest_path.is_symlink(): raise ValueError("linked manifest refused")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schema") != 1 or not isinstance(manifest.get("files"), list): raise ValueError("invalid manifest")
    seen = set()
    for entry in manifest["files"]:
        if entry["path"] in seen: raise ValueError("duplicate manifest path")
        seen.add(entry["path"])
        data = safe_file(backup, entry["path"]).read_bytes()
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]: raise ValueError("backup hash mismatch")
    actual = {p.relative_to(backup).as_posix() for p in backup.rglob("*") if p.is_file() and p != manifest_path}
    if actual != seen: raise ValueError("unlisted backup file")
    if args.mode == "verify": print(json.dumps({"verified": len(seen)})); return
    work, control = root(args.workspace), root(args.control)
    separate(work, control); separate(work, backup); separate(control, backup)
    if work.exists() or control.exists(): raise ValueError("restore never overwrites existing roots")
    origin = pathlib.Path(manifest["originControl"])
    # Same-host source lock must also be free. Across hosts, stop the source host before transfer.
    with locked(origin) if origin.exists() else contextlib.nullcontext():
        work.mkdir(mode=0o700, parents=True); control.mkdir(mode=0o700, parents=True)
        for entry in manifest["files"]:
            category, rest = entry["path"].split("/", 1)
            destination = (work if category == "workspace" else control) / rest
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with destination.open("xb") as out: out.write(safe_file(backup, entry["path"]).read_bytes()); out.flush(); os.fsync(out.fileno())
            destination.chmod(entry["mode"] & 0o777)
        print(json.dumps({"restored": len(seen), "controlDirMustBeExplicit": str(control), "sourceMustRemainStopped": True}))

try: main()
except Exception as error:
    print(str(error), file=sys.stderr); sys.exit(1)
