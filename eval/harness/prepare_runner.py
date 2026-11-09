"""Prepare isolated source snapshots for the direct Runner benchmark."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SOURCE = Path("packages/lightclaw/src")
BASE_REFS = {
    "S0": "1962a1a57509953076fcdd727bba0dd4c8558b10",
    "S1": "ae7683865",
}


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=REPO)


def source_digest(path: Path) -> str:
    digest = hashlib.sha256()
    for file in sorted(path.rglob("*")):
        if file.is_symlink():
            raise ValueError("Runner source must not contain symlinks")
        if file.is_file():
            digest.update(file.relative_to(path).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest()


def derive_truncation_control(destination: Path) -> Path:
    """Keep the S0 Runner and prompts, substituting only the S1 memory reader."""
    source = destination / "T" / SOURCE
    shutil.copytree(destination / "S0" / SOURCE, source)
    agent_path = source / "agent.ts"
    base = agent_path.read_text(encoding="utf-8")
    donor = (destination / "S1" / SOURCE / "agent.ts").read_text(encoding="utf-8")
    end = "function loadLightClawSkills("
    start = base.index("function getMemory(")
    donor_start = donor.index("const MEMORY_INDEX_BYTES =")
    memory_reader = donor[donor_start:donor.index(end, donor_start)].replace(
        "function getMemory(channelDir: string, channelIsolated: boolean)",
        "function getMemory(channelDir: string, channelIsolated = false)",
        1,
    )
    old_import = 'import { existsSync, readFileSync } from "fs";'
    if base.count(old_import) != 1 or "channelIsolated = false" not in memory_reader:
        raise ValueError("Frozen sources do not match the truncation control derivation")
    base = base[:start] + memory_reader + base[base.index(end, start):]
    base = base.replace(old_import, 'import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "fs";', 1)
    agent_path.write_text(base, encoding="utf-8")
    return source


def prepare(destination: Path, s2_ref: str | None = None) -> dict:
    destination = destination.resolve()
    if destination.is_relative_to(REPO / "packages") or destination.is_relative_to(REPO / "eval/memory_eval_kit"):
        raise ValueError("Choose a scratch directory outside app source and frozen evaluation fixtures")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Runner runtime must be prepared in a fresh empty directory")
    if not (REPO / "node_modules/tsx").is_dir():
        raise ValueError("Install repository dependencies before preparing the Runner")
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    adapter = (HERE / "runner.ts").read_bytes()
    adapter_sha = hashlib.sha256(adapter).hexdigest()
    manifest = {}
    for variant, ref in {**BASE_REFS, "S2": s2_ref}.items():
        snapshot = destination / variant
        source = snapshot / SOURCE
        if ref is None:
            commit = git("rev-parse", "HEAD").decode().strip()
            shutil.copytree(REPO / SOURCE, source, symlinks=True)
        else:
            commit = git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").decode().strip()
            archive = git("archive", "--format=tar", commit, "--", SOURCE.as_posix())
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as handle:
                handle.extractall(snapshot, filter="data")
        manifest[variant] = {
            "commit": commit,
            "worktree": ref is None,
            "sourceSha256": source_digest(source),
            "adapterSha256": adapter_sha,
        }
    control = derive_truncation_control(destination)
    manifest["T"] = {
        "commit": manifest["S0"]["commit"],
        "worktree": False,
        "derivedFrom": {"runnerCommit": manifest["S0"]["commit"], "memoryReaderCommit": manifest["S1"]["commit"]},
        "derivation": "S0 Runner with S1 memory reader and unchanged S0 prompt policy",
        "sourceSha256": source_digest(control),
        "adapterSha256": adapter_sha,
    }

    (destination / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
    (destination / "package.json").write_text('{"type":"module","private":true}\n', encoding="utf-8")
    root_config = json.loads((REPO / "tsconfig.json").read_text(encoding="utf-8"))
    paths = root_config["compilerOptions"]["paths"]
    config = {
        "extends": str(REPO / "tsconfig.base.json"),
        "compilerOptions": {
            "noEmit": True,
            "paths": {alias: [f"{REPO}/{path.removeprefix('./')}" for path in targets] for alias, targets in paths.items()},
        },
        "include": ["runner.ts"],
    }
    (destination / "tsconfig.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    (destination / "runner.ts").write_bytes(adapter)
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--s2-ref", help="Use the indicated Git commit/tag for S2 instead of the current worktree")
    args = parser.parse_args()
    print(json.dumps(prepare(args.destination, args.s2_ref)))
