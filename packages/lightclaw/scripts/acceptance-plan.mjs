#!/usr/bin/env node
// Preparation only; no SDK, credentials, model requests or outbound messages.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const platform = {
 schema: 1, status: "pending-user-authorization", platform: null, dedicatedApplication: null, credentialInjection: null,
 dedicatedConversation: null, participants: [], allowCounts: { send: 0, edit: 0, recall: 0, upload: 0 }, allowNetworkInterruption: false, allowPermissionChange: false,
 cases: ["text send/receive", "file/image read/result", "duplicate delivery/reconnect", "permission failure", "429", "approval continuation and identity", "final notification failure"],
 proposedMinimumCounts: { send: 12, edit: 2, recall: 2, upload: 2 },
 offlineCommand: "rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/platform-contract.test.ts test/platform-notifications.test.ts test/approval-authority.test.ts test/main-lifecycle.test.ts",
 run: ["User fills application/session/participants/injection and explicit counts", "Use dedicated app only; validate authorized conversation before any action", "Record every created message/file ID in session-receipts.jsonl; stop before exhausting approved count", "Inject only explicitly authorized connection/permission faults", "Compare platform receipts, durable inbox, approvals, results and audit"],
 cleanup: ["Restore any explicitly authorized dedicated-app permission/network changes", "Recall only IDs in this session's receipts, within approved recall count", "Stop dedicated test instance and confirm kernel lock release", "Keep audit/inbox/operation evidence; do not delete unresolved records", "Revoke dedicated app test credentials using the user's chosen injection mechanism"],
 safety: "This script only prepares a plan. It does not connect to any platform. No implicit live authorization.",
};
const tasksBytes = readFileSync(join(packageRoot, "evals/reliability/tasks.json"));
const tasks = JSON.parse(tasksBytes);
const model = {
 schema: 1, status: "pending-user-authorization", model: "openai/gpt-4.1-mini", modelSource: "installed pi-ai catalog; live availability and billing tariff not verified",
 repetitions: 2, tasks: { development: 13, selection: 12, blind: 11 },
 axes: { A: "baseline vs governed; hold prompt fixed", B: "governed vs frozen candidate; hold runtime fixed" },
 proposedAttempts: { development: 52, selection: 48, blind: 66, total: 166 },
 candidateGenerationRequests: 2, maxRequestsPerAttempt: 8,
 limits: { requests: 1330, tokens: 1000000, costMicros: 5000000, wallMs: 3600000, tokensPerRequest: 16384, costMicrosPerRequest: 100000 },
 expectedDurationMinutes: [30, 60], durationEvidence: "planning estimate only; budget stops can leave tasks incomplete",
 stopConditions: ["Any persisted request/token/cost/wall ceiling", "Unknown usage retains conservative reservation", "Provider usage exceeds reservation", "Frozen source/data/prompt changed", "Task Docker isolation or budget persistence cannot be verified", "Authorization scope or billing tariff cannot be established"],
 splits: tasks.map(task => ({ id: task.id, split: task.split, family: task.family, taskSha256: sha256(JSON.stringify(task)) })),
 tasksSha256: sha256(tasksBytes), candidateSha256: null,
 blind: { status: "locked-pending-selection-and-user-approval", mayInformCandidateSelection: false },
 reporting: ["task-level paired repetitions and task bootstrap intervals", "failed/missing/not-started remain in planned denominator", "all candidates and generation/selection costs, not only selected candidate", "human interventions plus measured minutes; unmeasured human time remains unknown", "development/selection/blind outputs in separate new directories; never overwrite history"],
 safety: "Faux wiring cannot demonstrate model benefit. Paid execution is not enabled by this plan.",
};
try {
 const [mode = "platform", flag, destination] = process.argv.slice(2);
 if (!["platform", "model"].includes(mode)) throw new Error("Use platform|model [--out FRESH_FILE]");
 const plan = mode === "platform" ? platform : model;
 if (flag) { if (flag !== "--out" || !destination || existsSync(resolve(destination))) throw new Error("Fresh --out file required"); mkdirSync(dirname(resolve(destination)), { recursive: true }); writeFileSync(resolve(destination), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
 console.log(JSON.stringify(plan, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
