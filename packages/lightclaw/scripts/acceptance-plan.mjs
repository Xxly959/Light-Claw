#!/usr/bin/env node
// Preparation only; no SDK, credentials, model requests or outbound messages.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const platform = {
 schema: 1, status: "pending-user-authorization", platform: null, dedicatedApplication: null, credentialInjection: null,
 dedicatedConversation: null, participants: [], allowCounts: { send: 0, edit: 0, recall: 0, upload: 0 }, allowNetworkInterruption: false, allowPermissionChange: false,
 cases: ["prompt composer: explicit submit mode, actor/chat/card binding, unchanged input or structured rewrite preview, edit and confirm before execution", "text send/receive", "file/image read/result", "duplicate delivery/reconnect", "permission failure", "429", "approval continuation and identity", "final notification failure"],
 proposedMinimumCounts: { send: 12, edit: 2, recall: 2, upload: 2 },
 offlineCommand: "rtk proxy npx tsx ../../node_modules/vitest/dist/cli.js --run test/platform-contract.test.ts test/platform-notifications.test.ts test/approval-authority.test.ts test/main-lifecycle.test.ts",
 run: ["User fills application/session/participants/injection and explicit counts", "Use dedicated app only; validate authorized conversation before any action", "Record every created message/file ID in session-receipts.jsonl; stop before exhausting approved count", "Inject only explicitly authorized connection/permission faults", "Compare platform receipts, durable inbox, approvals, results and audit"],
 cleanup: ["Restore any explicitly authorized dedicated-app permission/network changes", "Recall only IDs in this session's receipts, within approved recall count", "Stop dedicated test instance and confirm kernel lock release", "Keep audit/inbox/operation evidence; do not delete unresolved records", "Revoke dedicated app test credentials using the user's chosen injection mechanism"],
 safety: "This script only prepares a plan. It does not connect to any platform. No implicit live authorization.",
};

function record(value, keys) {
 if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Scope object has missing or unexpected fields");
 return value;
}
function text(value, maximum = 512) {
 if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Scope identity/reference must be bounded nonempty text");
 return value;
}
function checkPlatformScope(path) {
 let fd;
 let bytes;
 try {
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw new Error("invalid file");
  const buffer = Buffer.alloc(65537);
  const length = readSync(fd, buffer, 0, buffer.length, 0);
  if (length > 65536) throw new Error("oversized file");
  bytes = buffer.subarray(0, length);
 } catch { throw new Error("Scope must be a bounded single-link regular JSON file"); }
 finally { if (fd !== undefined) closeSync(fd); }
 let value;
 try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Scope must be valid JSON"); }
 record(value, ["schema", "platform", "dedicatedApplication", "dedicatedConversation", "participants", "credentialInjection", "allowCounts", "allowNetworkInterruption", "allowPermissionChange"]);
 if (value.schema !== 1 || value.platform !== "feishu") throw new Error("Scope requires schema 1 and platform feishu");
 text(value.dedicatedApplication); text(value.dedicatedConversation);
 if (!Array.isArray(value.participants) || !value.participants.length || value.participants.length > 256) throw new Error("Scope requires dedicated participants");
 value.participants.forEach(participant => text(participant));
 if (new Set(value.participants).size !== value.participants.length) throw new Error("Scope participants must be distinct");
 const injection = record(value.credentialInjection, ["kind", "reference"]);
 text(injection.reference, 2048);
 if (injection.kind === "file") {
  if (!isAbsolute(injection.reference)) throw new Error("Credential file reference must be absolute");
 } else if (injection.kind === "environment") {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(injection.reference)) throw new Error("Environment reference must be a variable or namespace name");
 } else throw new Error("Credential injection must be an environment or file reference; no inline credentials");
 const counts = record(value.allowCounts, ["send", "edit", "recall", "upload"]);
 if (Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0) || !Object.values(counts).some(count => count > 0)) throw new Error("Action limits must be explicit nonnegative safe integers with an authorized action");
 if (typeof value.allowNetworkInterruption !== "boolean" || typeof value.allowPermissionChange !== "boolean") throw new Error("Fault permissions must be explicit booleans");
 return { schema: 1, status: "scope-validated-not-executed", platform: "feishu", scopeSha256: sha256(bytes), participantCount: value.participants.length, allowCounts: counts, allowNetworkInterruption: value.allowNetworkInterruption, allowPermissionChange: value.allowPermissionChange, credentialReferenceRead: false, connectionVerified: false, requiresExplicitUserAuthorization: true };
}
try {
 const [mode = "platform", flag, destination, ...extra] = process.argv.slice(2);
 if (mode === "platform-check") {
  if (flag !== "--scope" || !destination || extra.length) throw new Error("Use platform-check --scope SCOPE_JSON");
  console.log(JSON.stringify(checkPlatformScope(resolve(destination)), null, 2));
 } else {
 if (mode !== "platform") throw new Error("Use platform [--out FRESH_FILE] or platform-check --scope SCOPE_JSON");
 const plan = platform;
 if (flag) { if (flag !== "--out" || !destination || existsSync(resolve(destination))) throw new Error("Fresh --out file required"); mkdirSync(dirname(resolve(destination)), { recursive: true }); writeFileSync(resolve(destination), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
 console.log(JSON.stringify(plan, null, 2));
 }
} catch (error) { console.error(`NOT READY: ${error.message}`); process.exitCode = 1; }
