"""Prepare fixed, local samples of official benchmarks without running a model."""

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
import hashlib
from http.client import HTTPException
import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from urllib.request import urlopen

from pyarrow.parquet import read_table


SEED = 20261108
OUTPUT = Path(__file__).resolve().parents[1] / "external"
LONGMEM_TYPES = {
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
}


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    revision: str
    sha256: str
    license: str


def huggingface(name: str, repo: str, revision: str, path: str, digest: str) -> Source:
    return Source(
        name, f"https://huggingface.co/datasets/{repo}/resolve/{revision}/{path}", revision, digest, "MIT"
    )


MAB_REPO = "ai-hyz/MemoryAgentBench"
MAB_REVISION = "7ea066982b140a19337e17e60d45d4076e042faf"
LOCOMO_REVISION = "cbfbc1dba6bc53d00625212a0f22d55ffee7c1fc"
SOURCES = (
    huggingface(
        "longmemeval_s", "xiaowu0162/longmemeval-cleaned", "98d7416c24c778c2fee6e6f3006e7a073259d48f",
        "longmemeval_s_cleaned.json", "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
    ),
    huggingface(
        "memoryagentbench_factconsolidation", MAB_REPO, MAB_REVISION,
        "data/Conflict_Resolution-00000-of-00001.parquet", "24d5c3f09ce0ce15625cb9f8a98f44f0d864ca6c94d7b4ad04eb697ca3a5ff45",
    ),
    huggingface(
        "memoryagentbench_eventqa", MAB_REPO, MAB_REVISION,
        "data/Accurate_Retrieval-00000-of-00001.parquet", "56c3cd80fb6731a3e53cd1a6be3148f54df60ff2d290ee50e28f8acebf9655c1",
    ),
    Source(
        "locomo", f"https://raw.githubusercontent.com/snap-research/locomo/{LOCOMO_REVISION}/data/locomo10.json",
        LOCOMO_REVISION, "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4", "CC-BY-NC-4.0",
    ),
)


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def cache_source(source: Source, local_only: bool) -> Path:
    path = OUTPUT / "cache" / source.url.rsplit("/", 1)[1]
    if path.is_file() and file_sha256(path) == source.sha256:
        return path
    if local_only:
        raise OSError(f"Missing or invalid local cache for {path.name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=path.parent) as temporary:
        staged = Path(temporary) / path.name
        with urlopen(source.url, timeout=90) as response, staged.open("wb") as stream:
            shutil.copyfileobj(response, stream, length=1024 * 1024)
        if file_sha256(staged) != source.sha256:
            raise ValueError(f"SHA-256 mismatch for {path.name}")
        staged.replace(path)
    return path


def rank(namespace: str, source_id: str) -> bytes:
    return hashlib.sha256(f"{SEED}/{namespace}/{source_id}".encode("utf-8")).digest()


def sample_longmem(records: list[dict], sample_size: int) -> tuple[list[dict], dict]:
    groups = defaultdict(list)
    ids = set()
    for record in records:
        source_id = record["question_id"]
        question_type = record["question_type"]
        if source_id in ids or question_type not in LONGMEM_TYPES:
            raise ValueError("Unexpected question ID or type in LongMemEval-S")
        ids.add(source_id)
        groups[(question_type, source_id.endswith("_abs"))].append(record)

    total = len(records)
    if not len(groups) <= sample_size <= total:
        raise ValueError("Sample size must cover all nonempty strata and fit the population")
    quotas = {key: max(1, len(group) * sample_size // total) for key, group in groups.items()}
    while sum(quotas.values()) < sample_size:
        key = max(
            (key for key, group in groups.items() if quotas[key] < len(group)),
            key=lambda key: (len(groups[key]) * sample_size - quotas[key] * total, key),
        )
        quotas[key] += 1
    while sum(quotas.values()) > sample_size:
        key = max(
            (key for key in groups if quotas[key] > 1),
            key=lambda key: (quotas[key] * total - len(groups[key]) * sample_size, key),
        )
        quotas[key] -= 1

    episodes = []
    strata = []
    for (question_type, abstention), group in sorted(groups.items()):
        quota = quotas[question_type, abstention]
        selected = sorted(group, key=lambda row: (rank("longmemeval_s", row["question_id"]), row["question_id"]))[:quota]
        for record in selected:
            if not len(record["haystack_session_ids"]) == len(record["haystack_dates"]) == len(record["haystack_sessions"]):
                raise ValueError(f"Misaligned history for {record['question_id']}")
            episodes.append({"source_id": record["question_id"], "record": record})
        strata.append({"question_type": question_type, "abstention": abstention, "population": len(group), "sampled": quota})
    return episodes, {"population_questions": total, "strata": strata}


def sample_mab(path: Path, factconsolidation: bool) -> tuple[list[dict], dict]:
    source_names = {"factconsolidation_sh_6k", "factconsolidation_mh_6k"} if factconsolidation else {"eventqa_65536"}
    per_episode = 20 if factconsolidation else 4
    expected_episodes = 2 if factconsolidation else 5
    episodes = []
    population = Counter()
    for row_index, row in enumerate(read_table(path).to_pylist()):
        source = row["metadata"]["source"]
        if source not in source_names:
            continue
        source_id = f"{source}:{row_index}"
        question_ids = row["metadata"]["qa_pair_ids"]
        if len(row["questions"]) != len(row["answers"]) or len(row["questions"]) != len(question_ids):
            raise ValueError(f"Misaligned questions, answers or IDs for {source_id}")
        if len(question_ids) != len(set(question_ids)) or len(question_ids) < per_episode:
            raise ValueError(f"Unexpected question IDs for {source_id}")
        selected = sorted(range(len(question_ids)), key=lambda i: rank(source_id, question_ids[i]))[:per_episode]
        population[source] += len(question_ids)
        episodes.append({"source_id": source_id, "question_indices": sorted(selected), "record": row})
    if len(episodes) != expected_episodes or population.keys() != source_names:
        raise ValueError(f"Unexpected official MemoryAgentBench rows: {dict(population)}")
    return episodes, {"population_questions_by_source": dict(population)}


def sample_locomo(records: list[dict]) -> tuple[list[dict], dict]:
    if len(records) != 10 or len({row["sample_id"] for row in records}) != 10:
        raise ValueError("Unexpected official LoCoMo conversations")
    categories = {1, 2, 3, 4, 5}
    eligible = [row for row in records if {qa["category"] for qa in row["qa"]} == categories]
    if len(eligible) < 2:
        raise ValueError("Fewer than two LoCoMo conversations cover all five categories")
    episodes = []
    for row in sorted(eligible, key=lambda row: rank("locomo", row["sample_id"]))[:2]:
        groups = defaultdict(list)
        for i, qa in enumerate(row["qa"]):
            groups[qa["category"]].append(i)
        selected = [min(group, key=lambda i: rank(row["sample_id"], str(i))) for group in groups.values()]
        episodes.append({"source_id": row["sample_id"], "question_indices": sorted(selected), "record": row})
    return episodes, {"population_questions": sum(len(row["qa"]) for row in records), "eligible_conversations": len(eligible)}


def prepare_sample(source: Source, path: Path) -> tuple[list[dict], dict]:
    if source.name.startswith("memoryagentbench_"):
        return sample_mab(path, source.name == "memoryagentbench_factconsolidation")
    with path.open(encoding="utf-8") as stream:
        rows = json.load(stream)
    if source.name == "locomo":
        return sample_locomo(rows)
    if len(rows) != 500 or {row["question_type"] for row in rows} != LONGMEM_TYPES:
        raise ValueError("Unexpected official LongMemEval-S questions or strata")
    return sample_longmem(rows, 120)


def write_artifact(path: Path, values: list[dict], jsonl: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=path.parent) as temporary:
        staged = Path(temporary) / path.name
        with staged.open("w", encoding="utf-8") as stream:
            for value in values:
                stream.write(json.dumps(value, ensure_ascii=False, indent=None if jsonl else 2) + "\n")
        staged.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-only", action="store_true", help="verify and prepare cached official data without network access")
    args = parser.parse_args()
    datasets = {}
    for source in SOURCES:
        entry = {"url": source.url, "revision": source.revision, "expected_sha256": source.sha256, "license": source.license}
        datasets[source.name] = entry
        try:
            print(f"{source.name}: checking official source", flush=True)
            path = cache_source(source, args.local_only)
            entry.update(raw=str(path.relative_to(OUTPUT)), raw_bytes=path.stat().st_size, raw_sha256=source.sha256)
            episodes, details = prepare_sample(source, path)
            sample = OUTPUT / "prepared" / f"{source.name}.jsonl"
            write_artifact(sample, episodes, jsonl=True)
            entry.update(
                details,
                status="prepared",
                artifact=str(sample.relative_to(OUTPUT)),
                artifact_sha256=file_sha256(sample),
                episodes=len(episodes),
                questions=sum(len(episode.get("question_indices", [0])) for episode in episodes),
                selections=[{key: value for key, value in episode.items() if key != "record"} for episode in episodes],
            )
            print(f"{source.name}: {entry['episodes']} episodes, {entry['questions']} questions", flush=True)
        except (OSError, HTTPException, ValueError, KeyError, TypeError) as error:
            entry.update(status="failed", error=str(error))
            print(f"{source.name}: {error}", flush=True)

    datasets["cl_bench"] = {
        "status": "skipped",
        "reason": "Optional context-learning benchmark with a custom evaluation-only data license",
        "url": "https://huggingface.co/datasets/tencent/CL-bench/resolve/b28a5832a09b0d96c0cf4c22e90d7c60ede25b80/CL-bench.jsonl",
        "revision": "b28a5832a09b0d96c0cf4c22e90d7c60ede25b80",
        "license": "custom evaluation-only",
    }
    manifest = {"schema_version": 1, "seed": SEED, "datasets": datasets}
    write_artifact(OUTPUT / "manifest.json", [manifest], jsonl=False)
    return int(any(entry["status"] == "failed" for entry in datasets.values()))


if __name__ == "__main__":
    raise SystemExit(main())
