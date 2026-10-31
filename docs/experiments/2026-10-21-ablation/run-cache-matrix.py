import datetime
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(__file__).resolve().parent
ARMS = ["disabled", "capacity", "ttl", "combined"]
records = []
for repetition in range(3):
    for offset in range(len(ARMS)):
        arm = ARMS[(repetition + offset) % len(ARMS)]
        destination = OUT / "raw" / f"cache-{repetition}-{arm}.json"
        command = ["rtk", "proxy", "node", "--expose-gc", "--import", "tsx", str(OUT / "run-cache.mjs"), arm, str(destination)]
        started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        clock = time.monotonic()
        result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
        record = {"arm": arm, "repetition": repetition, "command": command, "cwd": str(ROOT), "startedAt": started,
                  "durationSeconds": time.monotonic() - clock, "exitCode": result.returncode,
                  "stdout": result.stdout, "stderr": result.stderr}
        records.append(record)
        (OUT / "raw/cache-commands.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"arm": arm, "repetition": repetition, "exitCode": result.returncode,
                          "seconds": record["durationSeconds"], "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}, ensure_ascii=False), flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
