"""Measure structural properties of the dev fixtures without a model."""
import argparse
import json
from pathlib import Path

from lint_memory import lint_layout
from render_s2 import CHANNEL, FEATURES, render_s2

EVAL = Path(__file__).resolve().parents[1]
KIT = EVAL / "memory_eval_kit/testset/fixtures"


def visible(raw):
    window = raw if len(raw) <= 4096 else raw[:4096].rsplit(b"\n", 1)[0] if b"\n" in raw[:4096] else b""
    return window.decode("utf-8").strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plot", action="store_true")
    args = parser.parse_args()
    rows = []
    for path in sorted(KIT.glob("*-dev")):
        doc = json.loads((path / "facts.json").read_text(encoding="utf-8"))
        files, mapping = render_s2(doc, features=FEATURES)
        mono = (path / "monolith/channel/MEMORY.md").read_bytes()
        index = (path / "index_notes/channel/MEMORY.md").read_bytes()
        s1_global = visible((path / "index_notes/MEMORY.md").read_bytes())
        rules = [fact for fact in doc["facts"] if fact["kind"] == "rule"]
        rows.append({
            "fixture": path.name, "s0_channel_bytes": len(mono), "s1_channel_file_bytes": len(index),
            "s1_channel_visible_bytes": len(visible(index).encode()), "s2_channel_bytes": len(files[f"{CHANNEL}/MEMORY.md"].encode()),
            "s1_visible_rules": sum(fact["text"] in s1_global for fact in rules),
            "s2_visible_rules": sum(mapping[fact["id"]] == "MEMORY.md" for fact in rules),
            "rules": len(rules), "facts_mapped": len(mapping), "notes": len(files) - 2,
            "lint": lint_layout(files, mapping),
        })
    figures = EVAL / "figures"
    figures.mkdir(exist_ok=True)
    (figures / "dev-layout.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.plot:
        import matplotlib.pyplot as plt

        plt.rcParams["svg.hashsalt"] = "lightclaw-memory-layout"
        fig, (first, second) = plt.subplots(1, 2, figsize=(10, 3.9), layout="constrained")
        x = [12, 32, 64, 128]
        for key, title in (("s0_channel_bytes", "S0 full file"), ("s1_channel_visible_bytes", "S1 visible prefix"), ("s2_channel_bytes", "S2 index")):
            first.plot(x, [row[key] for row in rows], "-o", label=title)
        first.set(xlabel="Dev fixture target KiB", ylabel="Visible channel memory bytes", yscale="log", xticks=x)
        first.legend(frameon=False)
        for key, title in (("s1_visible_rules", "S1"), ("s2_visible_rules", "S2")):
            second.plot(x, [row[key] for row in rows], "-o", label=title)
        second.set(xlabel="Dev fixture target KiB", ylabel="Rules visible at first request", ylim=(0, 5.4), xticks=x)
        second.legend(frameon=False)
        output = figures / "dev-layout.svg"
        fig.savefig(output, metadata={"Date": None})
        lines = output.read_text(encoding="utf-8").splitlines()
        output.write_text("\n".join(line.rstrip() for line in lines) + "\n", encoding="utf-8")
    print(json.dumps(rows, ensure_ascii=False))


if __name__ == "__main__":
    main()
