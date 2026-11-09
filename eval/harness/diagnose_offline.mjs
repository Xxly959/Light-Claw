import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../..", import.meta.url));
const agentPath = "packages/lightclaw/src/agent.ts";
const s0Revision = "1962a1a57";
const s1Revision = "ae768386578625ffcea7262aece94ca7c957dbde";

function gitSource(spec) {
	return execFileSync("git", ["show", spec], { cwd: root, encoding: "utf8" });
}

function excerpt(source, start, end) {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert(from >= 0 && to > from, `Cannot locate source boundaries: ${start} … ${end}`);
	return source.slice(from, to);
}

function evaluate(source, scope) {
	return runInNewContext(stripTypeScriptTypes(source), scope);
}

// Each synthetic descriptor captures the file snapshot when opened.
const files = new Map();
const handles = new Map();
let nextFd = 0;
const bytesRead = { S0: 0, S1: 0 };
const scope = {
	Buffer,
	TextDecoder,
	join,
	constants,
	process: { cwd: () => "/fixture" },
	log: { logWarning() {} },
	existsSync: (path) => files.has(path),
	readFileSync(path) {
		const file = files.get(path);
		bytesRead.S0 += file.length;
		return file.toString("utf8");
	},
	openSync(path) {
		if (!files.has(path)) throw Object.assign(Error("Missing synthetic file"), { code: "ENOENT" });
		const fd = nextFd++;
		handles.set(fd, { file: files.get(path), position: 0 });
		return fd;
	},
	closeSync: (fd) => handles.delete(fd),
	fstatSync: () => ({ isFile: () => true }),
	readSync(fd, buffer, offset, limit) {
		const handle = handles.get(fd);
		const count = handle.file.copy(buffer, offset, handle.position, handle.position + limit);
		handle.position += count;
		bytesRead.S1 += count;
		return count;
	},
};

function loadPromptHelpers(source, start) {
	const memory = excerpt(source, start, "function loadLightClawSkills(");
	const prompt = excerpt(source, "export function buildSystemPrompt(", "function extractToolResultText(")
		.replace("export ", "");
	return evaluate(memory + prompt + "\n({getMemory, buildSystemPrompt})", scope);
}

const readers = {
	S0: loadPromptHelpers(gitSource(`${s0Revision}:${agentPath}`), "function getMemory("),
	S1: loadPromptHelpers(
		process.argv[2] ? readFileSync(process.argv[2], "utf8") : gitSource(`${s1Revision}:${agentPath}`),
		"const MEMORY_INDEX_BYTES",
	),
};
const globalPath = "/fixture/MEMORY.md";
const channelA = "/fixture/a/MEMORY.md";
const channelB = "/fixture/b/MEMORY.md";
const set = (path, content) => files.set(path, Buffer.from(content));
const get = (variant, channel = "a", isolated = false) => readers[variant].getMemory(`/fixture/${channel}`, isolated);

set(globalPath, "GLOBAL");
const oldPrefix = "OLD\n".repeat(1024);
set(channelA, oldPrefix);
assert(!get("S1").includes("index exceeds 4 KiB"));
set(channelA, oldPrefix + "NEW_RULE\n");
assert(get("S0").includes("NEW_RULE"));
const overflow = get("S1");
assert(overflow.includes("index exceeds 4 KiB"));
assert(!overflow.includes("NEW_RULE"));
assert.equal(files.get(channelA).toString("utf8"), oldPrefix + "NEW_RULE\n");

const exactLine = "UNBROKEN".repeat(512);
set(channelA, exactLine);
assert(get("S1").includes(exactLine));
set(channelA, exactLine + "\n");
assert(!get("S1").includes("UNBROKEN"));

set(channelA, "HEADER\n" + "x".repeat(131072) + "\nTAIL");
bytesRead.S0 = 0;
bytesRead.S1 = 0;
assert(get("S0").includes("TAIL"));
assert(!get("S1").includes("TAIL"));
const boundedRead = { ...bytesRead };
assert.deepEqual(boundedRead, { S0: 131090, S1: 4103 });

const fileOnlyCapacity = {};
for (const [label, char] of [["ASCII", "a"], ["CJK", "记"], ["emoji", "🙂"]]) {
	const count = Math.floor(4096 / Buffer.byteLength(char));
	const content = char.repeat(count);
	set(channelA, content);
	assert(get("S1").includes(content));
	assert(!get("S1").includes("index exceeds 4 KiB"));
	set(channelA, content + char);
	assert(get("S1").includes("index exceeds 4 KiB"));
	fileOnlyCapacity[label] = count;
}
set(channelA, Buffer.concat([Buffer.from("GOOD_RULE\n"), Buffer.from([0xff])]));
assert(!get("S1").includes("GOOD_RULE"));

set(channelA, "GLOBAL");
assert.equal(get("S1").match(/\bGLOBAL\b/g).length, 2);
set(channelA, "PRIVATE_A");
set(channelB, "PRIVATE_B");
assert(get("S1", "a").includes("GLOBAL") && !get("S1", "a").includes("PRIVATE_B"));
assert(get("S1", "b").includes("GLOBAL") && !get("S1", "b").includes("PRIVATE_A"));
set(globalPath, "GLOBAL_PRIVATE_A");
assert(get("S1", "b", true).includes("GLOBAL_PRIVATE_A"));

function makePrompt(variant, memory) {
	set(globalPath, memory);
	return Buffer.from(readers[variant].buildSystemPrompt(
		"/fixture", "a", get(variant), { type: "host" }, [], [], [], {},
		"feishu", undefined, undefined, false, false,
	));
}

const commonSystemPrefixBytes = {};
for (const variant of ["S0", "S1"]) {
	const before = makePrompt(variant, "CACHE_KEY_X\nSAME_TAIL");
	const after = makePrompt(variant, "CACHE_KEY_Y\nSAME_TAIL");
	const divergence = before.findIndex((byte, index) => byte !== after[index]);
	assert(divergence > 0 && divergence < after.length);
	commonSystemPrefixBytes[variant] = divergence;
}

const editSource = gitSource(`${s0Revision}:packages/lightclaw/src/tools/edit.ts`);
const createEditTool = evaluate(
	excerpt(editSource, "function generateDiffString(", "\nfunction shellEscape(").replace("export ", "")
		+ "\n" + editSource.slice(editSource.indexOf("function shellEscape(")) + "\ncreateEditTool",
	{ Type: { Object: (schema) => schema, String: () => ({}) }, Diff: { diffLines: () => [] } },
);
let sharedFile = "A=old\nB=old\n";
let readCount = 0;
let releaseReads;
const readsComplete = new Promise((resolve) => { releaseReads = resolve; });
let releaseFirstWrite;
const firstWriteComplete = new Promise((resolve) => { releaseFirstWrite = resolve; });
const executor = {
	async exec(command) {
		if (command.startsWith("cat ")) {
			const snapshot = sharedFile;
			if (++readCount === 2) releaseReads();
			await readsComplete;
			return { code: 0, stdout: snapshot };
		}
		const match = /^printf '%s' '([^']*)' > '\/fixture\/MEMORY\.md'$/.exec(command);
		assert(match, "Unexpected synthetic write");
		const next = match[1];
		if (next.includes("A=new")) {
			sharedFile = next;
			releaseFirstWrite();
		} else {
			await firstWriteComplete;
			sharedFile = next;
		}
		return { code: 0 };
	},
};
const [editA, editB] = await Promise.all(
	["A", "B"].map((key) => createEditTool(executor).execute(key, {
		label: "Synthetic shared edit",
		path: globalPath,
		oldText: `${key}=old`,
		newText: `${key}=new`,
	})),
);
assert(editA.content[0].text.startsWith("Successfully"));
assert(editB.content[0].text.startsWith("Successfully"));
assert.equal(sharedFile, "A=old\nB=new\n");

console.log(JSON.stringify({
	appendHiddenInS1: true,
	exactCapThenLfHidesLine: true,
	invalidUtf8OmitsWholeIndex: true,
	boundedRead,
	fileOnlyCapacity,
	duplicateInjection: true,
	globalInjectedIntoIsolatedChannelB: true,
	commonSystemPrefixBytes,
	sharedEditLostUpdate: { bothReturnedSuccess: true, final: sharedFile.trim().split("\n") },
}, null, 2));
