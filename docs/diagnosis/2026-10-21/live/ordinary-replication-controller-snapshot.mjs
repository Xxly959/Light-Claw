import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = join(directory, "../../..");
const mode = process.argv[2] || "pilot";
if (!["pilot", "pilot2", "noise", "noise-host", "matrix", "matrix-docker", "matrix-host", "after", "ordinary", "ordinary-replication"].includes(mode)) throw new Error("Unknown mode");
const node = "/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
const dataPath = join(directory, "../../experiments/2026-10-21-ablation/prompt-dataset.json");
const dataset = JSON.parse(readFileSync(dataPath, "utf8"));
const names = ["goals", "acceptance", "feishu", "controls", "scheduling", "optimization", "infrastructure"];
const flags = value => Object.fromEntries(names.map(name => [name, value]));
const arms = [
  { name: "all-off", kind: "current", features: flags(false) },
  ...names.map(name => ({ name: `only-${name}`, kind: "current", features: { ...flags(false), [name]: true } })),
  { name: "all-on", kind: "current", features: flags(true) },
  ...names.map(name => ({ name: `without-${name}`, kind: "current", features: { ...flags(true), [name]: false } })),
];
const jobs = [];
if (mode.startsWith("pilot")) {
  for (const kind of ["upstream", "old", "current"])
    jobs.push({ arm: `pilot-${kind}`, kind, features: flags(true), repetition: 0, seed: 17, caseId: "train-orders" });
} else if (mode.startsWith("ordinary")) {
  for (let repetition = 0; repetition < 3; repetition++)
    for (const item of dataset.filter(item => item.split === "final")) {
      const variants = [{ name: "ordinary-before", kind: "current", startGoal: false }, { name: "ordinary-lean", kind: "lean", startGoal: false }, { name: "final-goal-lean", kind: "lean", startGoal: true }];
      if ((repetition + dataset.indexOf(item)) % 2) variants.reverse();
      for (const variant of variants) jobs.push({ arm: variant.name, kind: variant.kind, startGoal: variant.startGoal,
        features: flags(true), sandbox: "docker", repetition, seed: 17 + repetition * 104729, caseId: item.id });
    }
} else if (mode === "noise-host" || mode === "after") {
  for (let repetition = 0; repetition < (mode === "noise-host" ? 5 : 3); repetition++) {
    for (const item of dataset.filter(item => item.split === "final")) {
      const variants = mode === "noise-host" ? [{ name: "upstream-host", kind: "upstream" }]
        : [{ name: "before-terminal-fix", kind: "current" }, { name: "fixed-all-on", kind: "fixed" }];
      if ((repetition + dataset.indexOf(item)) % 2) variants.reverse();
      for (const variant of variants) jobs.push({ arm: variant.name, kind: variant.kind,
        features: mode === "noise-host" ? flags(false) : flags(true), sandbox: mode === "noise-host" ? "host" : "docker", repetition,
        seed: 17 + repetition * 104729, caseId: item.id });
    }
  }
} else if (mode === "noise") {
  for (let repetition = 0; repetition < 5; repetition++) {
    for (const item of dataset.filter(item => item.split === "final")) {
      for (const arm of [{ name: "upstream", kind: "upstream", features: flags(true) }, arms[0]])
        jobs.push({ arm: arm.name, kind: arm.kind, features: arm.features, repetition, seed: 17 + repetition * 104729, caseId: item.id });
    }
  }
} else {
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const item of dataset.filter(item => item.split === "final")) {
      const selected = arms.slice(1).filter(arm => mode === "matrix-docker" ? arm.features.infrastructure && arm.name !== "all-on" : mode === "matrix-host" ? !arm.features.infrastructure : true);
      const ordered = [...selected, ...(mode === "matrix-host" ? [] : [{ name: "old-all", kind: "old", features: flags(true) }])];
      if ((repetition + dataset.indexOf(item)) % 2) ordered.reverse();
      for (const arm of ordered) jobs.push({ arm: arm.name, kind: arm.kind, features: arm.features,
        repetition, seed: 17 + repetition * 104729, caseId: item.id });
    }
  }
}
for (const [index, job] of jobs.entries()) job.id = `${mode}-${String(index).padStart(4, "0")}-${job.arm}-${job.caseId}`;
const live = join(directory, "live");
mkdirSync(join(live, "jobs"), { recursive: true });
for (const job of jobs) writeFileSync(join(live, "jobs", `${job.id}.json`), JSON.stringify(job) + "\n");
const maxRequests = mode.startsWith("pilot") ? 90 : mode === "noise" ? 700 : mode === "noise-host" ? 400 : mode === "after" ? 400 : mode.startsWith("ordinary") ? 500 : mode === "matrix-host" ? 1500 : 3500;
const maxTokens = mode.startsWith("pilot") ? 300000 : mode === "noise" ? 2500000 : mode === "noise-host" ? 1500000 : mode === "after" ? 1200000 : mode.startsWith("ordinary") ? 1500000 : mode === "matrix-host" ? 5000000 : 13000000;
const freeze = { mode, frozenAt: new Date().toISOString(), node: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
  model: "deepseek-flash", temperature: 0.2, max_tokens: 2048, thinking: "disabled", seeds: [...new Set(jobs.map(job => job.seed))],
  maxRequests, maxReportedTokens: maxTokens, maxConcurrentTasks: 3, productLimits: { durationMs: 300000, toolCalls: 100, tokens: 100000, bashTimeoutSeconds: 120 }, perTaskExternalTimeoutMs: 120000, perTaskExternalRequestLimit: 30,
  note: "Token ceiling checked before dispatch; up to three in-flight requests may exceed it. Prices unknown. No candidate generated. Goal-enabled arms create equivalent file-existence acceptance and use the production-equivalent outer loop adapter. Queue and actual IM delivery are outside this runner experiment.",
  datasetSha256: createHash("sha256").update(readFileSync(dataPath)).digest("hex"),
  image: "sha256:061401acf8127a73b139afcecc1a1713d84e61cd9318d155f64802beef304809",
  leanSourceHashes: JSON.parse(readFileSync(join(directory, "live/source-lean.json"), "utf8")),
  fixedSourceHashes: JSON.parse(readFileSync(join(directory, "live/source-after.json"), "utf8")),
  productSourceHashes: JSON.parse(readFileSync(join(directory, "live/source-before.json"), "utf8")),
  upstreamSource: JSON.parse(readFileSync(join(directory, "upstream/manifest.json"), "utf8")),
  workerSha256: createHash("sha256").update(readFileSync(join(directory, "live-worker.mjs"))).digest("hex"),
  jobs };
if (mode === "matrix-host" && jobs.some(job => job.features.infrastructure)) throw new Error("Host-only phase contains an unexpected Docker job");
if (mode === "matrix-docker" && jobs.some(job => !job.features.infrastructure)) throw new Error("Container-only phase contains a host job");
writeFileSync(join(live, `${mode}-worker-snapshot.mjs`), readFileSync(join(directory, "live-worker.mjs")));
writeFileSync(join(live, `${mode}-controller-snapshot.mjs`), readFileSync(fileURLToPath(import.meta.url)));
const freezePath = join(live, `${mode}-freeze.json`);
if (existsSync(freezePath)) throw new Error("Refusing to overwrite a frozen experiment");
writeFileSync(freezePath, JSON.stringify(freeze, null, 2) + "\n");
let position = 0, reserved = 0, reportedTokens = 0, finished = 0;
const results = [];
let stopped = false;
const children = new Set();
process.on("SIGINT", () => { stopped = true; for (const child of children) child.kill("SIGTERM"); });
function docker(args) { return execFileSync("docker", args, { encoding: "utf8", timeout: 20000 }); }
for (let slot = 0; slot < 3; slot++) {
  if (mode === "noise-host" || mode === "matrix-host") continue;
  const workspace = `/private/tmp/lightclaw-diagnosis-live-20261021/slot-${slot}/workspace`;
  mkdirSync(workspace, { recursive: true });
  docker(["run", "-d", "--name", `lightclaw-diagnosis-live-${slot}`, "--network=none", "--cpus=1", "--memory=512m", "--pids-limit=128",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", `${process.getuid()}:${process.getgid()}`,
    "-v", `${workspace}:/workspace`, "lightclaw-sandbox:local", "sh", "-c", "while :; do sleep 3600; done"]);
}
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
async function consume(slot) {
  while (!stopped && position < jobs.length && reserved < maxRequests && reportedTokens < maxTokens) {
    const job = jobs[position++];
    const slotTag = mode === "noise-host" || mode === "matrix-host" ? `host-${slot}` : String(slot);
    const raw = join(live, "raw", job.id);
    mkdirSync(raw, { recursive: true });
    await new Promise(resolve => {
      const child = fork(join(directory, "live-worker.mjs"), [join(live, "jobs", `${job.id}.json`), slotTag],
        { execPath: node, execArgv: ["--import", "tsx"], cwd: root, env, silent: true });
      children.add(child);
      let stdout = "", stderr = "", summary, timeout = false;
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const timer = setTimeout(() => { timeout = true; child.kill("SIGKILL"); }, 120000);
      child.on("message", message => {
        if (message.type === "reserve") {
          const allowed = !stopped && reserved < maxRequests && reportedTokens < maxTokens;
          if (allowed) reserved++;
          child.send({ type: "reservation", id: message.id, allowed });
        } else if (message.type === "usage") reportedTokens += message.tokens;
        else if (message.type === "finished") summary = message.summary;
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer); children.delete(child); finished++;
        writeFileSync(join(raw, "stdout.log"), stdout);
        writeFileSync(join(raw, "stderr.log"), stderr);
        const row = { id: job.id, code, signal, timeout, summary: summary ?? null };
        if (!summary) {
          const sessionPath = `/private/tmp/lightclaw-diagnosis-live-20261021/slot-${slotTag}/workspace/task/context.jsonl`;
          if (existsSync(sessionPath)) writeFileSync(join(raw, "crashed-session.jsonl"), readFileSync(sessionPath));
          writeFileSync(join(raw, "harness-error.json"), JSON.stringify(row) + "\n");
        }
        results.push(row);
        appendFileSync(join(live, `${mode}-progress.jsonl`), JSON.stringify({ ...row, finished, planned: jobs.length, reserved, reportedTokens }) + "\n");
        console.log(JSON.stringify({ mode, finished, planned: jobs.length, arm: job.arm, success: summary?.success, code, reserved, reportedTokens }));
        resolve();
      });
    });
  }
}
try { await Promise.all([0, 1, 2].map(consume)); }
finally { for (let slot = 0; slot < 3; slot++) if (mode !== "noise-host" && mode !== "matrix-host") docker(["rm", "-f", `lightclaw-diagnosis-live-${slot}`]); }
writeFileSync(join(live, `${mode}-complete.json`), JSON.stringify({ completedAt: new Date().toISOString(), finished, planned: jobs.length,
  reserved, reportedTokens, stopped, budgetLimited: finished < jobs.length, results }, null, 2) + "\n");
if (finished !== jobs.length || results.some(row => row.code !== 0)) process.exitCode = 1;
