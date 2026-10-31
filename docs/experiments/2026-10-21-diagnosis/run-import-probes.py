import json
import pathlib
import subprocess
import time

OUT = pathlib.Path(__file__).resolve().parent
ROOT = OUT.parents[2]
(OUT / "raw").mkdir(exist_ok=True)
(OUT / "probes").mkdir(exist_ok=True)
subjects = {
    "native-empty": [], "tsx-empty": [],
    "queue": ["packages/lightclaw/src/channel-queue.ts"],
    "idle-cache": ["packages/lightclaw/src/idle-cache.ts"],
    "pi-ai": ["packages/ai/src/index.ts"],
    "agent-core": ["packages/agent/src/index.ts"],
    "coding-root": ["packages/coding-agent/src/index.ts"],
    "coding-narrow": ["packages/coding-agent/src/core/agent-session.ts", "packages/coding-agent/src/core/auth-storage.ts", "packages/coding-agent/src/core/session-manager.ts"],
    "lightclaw": ["packages/lightclaw/src/agent.ts"],
}
for name, paths in subjects.items():
    imports = "\n".join(f'import * as subject{i} from {json.dumps(str(ROOT / path))};' for i, path in enumerate(paths))
    exports = "+".join(f"Object.keys(subject{i}).length" for i in range(len(paths))) or "0"
    code = f'''import {{ getHeapStatistics, getHeapSpaceStatistics }} from "node:v8";
import {{ createRequire }} from "node:module";
{imports}
const require = createRequire(import.meta.url);
global.gc(); global.gc();
await new Promise((resolve) => setTimeout(resolve, 200));
global.gc();
console.log(JSON.stringify({{subject:{json.dumps(name)},exports:{exports},node:process.version,memory:process.memoryUsage(),heap:getHeapStatistics(),spaces:getHeapSpaceStatistics(),commonJsModules:Object.keys(require.cache).length}}));
'''
    (OUT / "probes" / f"{name}.mjs").write_text(code)

records = []
names = list(subjects)
for repetition in range(3):
    for offset in range(len(names)):
        name = names[(offset + repetition * 3) % len(names)]
        command = ["rtk", "proxy", "node", "--expose-gc"]
        if name != "native-empty":
            command += ["--import", "tsx"]
        command.append(str(OUT / "probes" / f"{name}.mjs"))
        start = time.monotonic()
        result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
        assert result.returncode == 0, result.stderr
        record = {"repetition": repetition, "command": command, "seconds": time.monotonic() - start,
                  "exitCode": result.returncode, "sample": json.loads(result.stdout)}
        records.append(record)
        (OUT / "raw/import-probes.json").write_text(json.dumps(records, indent=2) + "\n")
        print(json.dumps({"subject": name, "repetition": repetition, "rssMiB": record["sample"]["memory"]["rss"] / 2**20,
                          "heapMiB": record["sample"]["memory"]["heapUsed"] / 2**20}), flush=True)
