import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	type Model,
	registerApiProvider,
	registerFauxProvider,
	type ToolCall,
	Type,
} from "@mariozechner/pi-ai";
import { createAgentRunner as createS0 } from "./S0/packages/lightclaw/src/agent.js";
import { GoalStore as GoalsS0 } from "./S0/packages/lightclaw/src/goals/store.js";
import { ChannelStore as StoreS0 } from "./S0/packages/lightclaw/src/store.js";
import {
	type AgentRunnerOverrides,
	type AgentRunResult,
	createAgentRunner as createS1,
	resolveModelRef,
} from "./S1/packages/lightclaw/src/agent.js";
import { resolveAuditDirectory } from "./S1/packages/lightclaw/src/audit/storage.js";
import type { ToolAuditEvent } from "./S1/packages/lightclaw/src/audit/tool-audit.js";
import type { LightClawConfig } from "./S1/packages/lightclaw/src/config.js";
import { GoalStore as GoalsS1 } from "./S1/packages/lightclaw/src/goals/store.js";
import { initializeHttpTransport } from "./S1/packages/lightclaw/src/http.js";
import type { ModelAttempt } from "./S1/packages/lightclaw/src/model-router.js";
import { redactSecrets } from "./S1/packages/lightclaw/src/redaction.js";
import { createExecutor } from "./S1/packages/lightclaw/src/sandbox.js";
import { ChannelStore as StoreS1 } from "./S1/packages/lightclaw/src/store.js";
import { createReadTool } from "./S1/packages/lightclaw/src/tools/read.js";
import type { ChatContext } from "./S1/packages/lightclaw/src/transport.js";
import { createAgentRunner as createS2 } from "./S2/packages/lightclaw/src/agent.js";
import { GoalStore as GoalsS2 } from "./S2/packages/lightclaw/src/goals/store.js";
import { ChannelStore as StoreS2 } from "./S2/packages/lightclaw/src/store.js";
import { createAgentRunner as createT } from "./T/packages/lightclaw/src/agent.js";
import { GoalStore as GoalsT } from "./T/packages/lightclaw/src/goals/store.js";
import { ChannelStore as StoreT } from "./T/packages/lightclaw/src/store.js";

type Variant = "S0" | "S1" | "S2" | "T";
type Route = "faux" | "deepseek" | "configured";
type ReadArgs = { path: string; offset?: number; limit?: number };
type SearchArgs = { query: string; limit?: number };
type FauxTurn = { text?: string; read?: ReadArgs; search?: SearchArgs };

interface RunSpec {
	variant: Variant;
	prompt: string;
	files: Record<string, string>;
	channel?: string;
	model: { route: Route; turns?: FauxTurn[] };
	limits?: {
		maxToolCalls?: number;
		maxInputTokens?: number;
		maxOutputTokens?: number;
		attemptTimeoutMs?: number;
		runTimeoutMs?: number;
	};
}

const WORKSPACE = "/workspace";
const DEFAULT_LIMITS = {
	maxToolCalls: 5,
	maxInputTokens: 460_000,
	maxOutputTokens: 1_024,
	attemptTimeoutMs: 90_000,
	runTimeoutMs: 220_000,
};
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const INVALID_NOTE_CHAR = /[^\p{L}\p{N}._-]/u;
const KEY_AUTH_APIS = new Set<Api>(["openai-completions", "openai-responses", "anthropic-messages"]);

class HarnessError extends Error {}

async function readSpec(): Promise<RunSpec> {
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for await (const chunk of process.stdin) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			size += bytes.byteLength;
			if (size > 12 * 1_048_576) throw new HarnessError("Evaluation spec exceeds the input byte limit");
			chunks.push(bytes);
		}
	} catch (error) {
		if (error instanceof HarnessError) throw error;
		throw new HarnessError("Could not read the evaluation input stream");
	}
	let spec: RunSpec;
	try {
		spec = JSON.parse(Buffer.concat(chunks, size).toString("utf-8")) as RunSpec;
	} catch {
		throw new HarnessError("Evaluation input is not valid JSON");
	}
	if (
		!["S0", "S1", "S2", "T"].includes(spec?.variant) ||
		typeof spec.prompt !== "string" ||
		!spec.prompt.trim() ||
		Buffer.byteLength(spec.prompt) > 1_048_576 ||
		!spec.files ||
		typeof spec.files !== "object" ||
		Array.isArray(spec.files) ||
		!["faux", "deepseek", "configured"].includes(spec.model?.route)
	) {
		throw new HarnessError("Invalid evaluation spec");
	}
	return spec;
}

function fixturePath(path: string, channel: string): boolean {
	if (path === "MEMORY.md" || path === `${channel}/MEMORY.md`) return true;
	const prefix = [`${channel}/memory/`, ".shared/memory/"].find((candidate) => path.startsWith(candidate));
	if (!prefix) return false;
	const components = path.slice(prefix.length).split("/");
	const basename = components.pop() ?? "";
	return (
		basename.length > 3 &&
		basename.endsWith(".md") &&
		Buffer.byteLength(basename) <= 255 &&
		!INVALID_NOTE_CHAR.test(basename) &&
		components.every((name) => name.length <= 255 && SAFE_NAME.test(name))
	);
}

function writeFixture(workspace: string, channel: string, files: RunSpec["files"]): Set<string> {
	const entries = Object.entries(files);
	let bytes = 0;
	if (entries.length > 512) throw new HarnessError("Synthetic fixture has too many files");
	for (const [path, body] of entries) {
		if (!fixturePath(path, channel) || typeof body !== "string") {
			throw new HarnessError("Only synthetic Markdown memory files are permitted");
		}
		bytes += Buffer.byteLength(body);
		if (bytes > 2_097_152) throw new HarnessError("Synthetic fixture exceeds the size limit");
		const file = join(workspace, path);
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(file, body, { flag: "wx", mode: 0o600 });
	}
	return new Set(entries.map(([path]) => path).sort());
}

function fixtureUnchanged(workspace: string, channel: string, expected: RunSpec["files"]): boolean {
	const found: string[] = [];
	const metadata = new Set([`${channel}/.lightclaw-guide.md`, `${channel}/context.jsonl`, `${channel}/log.jsonl`]);
	const visit = (relative: string): void => {
		const path = join(workspace, relative);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || realpathSync(path) !== path) throw new HarnessError("Unexpected fixture link");
		if (stat.isDirectory()) {
			for (const entry of readdirSync(path)) visit(relative ? `${relative}/${entry}` : entry);
			return;
		}
		if (metadata.has(relative) && stat.isFile() && stat.nlink === 1) return;
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			!Object.hasOwn(expected, relative) ||
			!readFileSync(path).equals(Buffer.from(expected[relative]))
		) {
			throw new HarnessError("Synthetic memory changed during the run");
		}
		found.push(relative);
	};
	try {
		visit("");
		return found.length === Object.keys(expected).length;
	} catch {
		return false;
	}
}

function memoryTools(workspace: string, channel: string, allowed: Set<string>) {
	const host = createExecutor({ type: "host" }, 3);
	const read = createReadTool(host);
	const realFile = (relative: string): string => {
		const candidate = join(workspace, relative);
		const stat = lstatSync(candidate);
		if (!stat.isFile() || stat.nlink !== 1 || realpathSync(candidate) !== candidate) {
			throw new HarnessError("Only regular synthetic memory files may be read");
		}
		return candidate;
	};
	const readPath = (path: string): string | undefined => {
		const virtual = path.startsWith(`${WORKSPACE}/`);
		const normalized = virtual ? path.slice(WORKSPACE.length + 1) : path.replace(/^\.\//, "");
		if (allowed.has(normalized)) return normalized;
		if (virtual || !normalized.startsWith("memory/")) return undefined;
		const channelRelative = `${channel}/${normalized}`;
		return allowed.has(channelRelative) ? channelRelative : undefined;
	};
	const deniedCalls = new Set<string>();
	const safeRead: typeof read = {
		...read,
		async execute(id, args, signal, update) {
			const relative = readPath(args.path);
			if (!relative) {
				deniedCalls.add(id);
				throw new HarnessError("Only supplied synthetic memory files may be read");
			}
			for (const number of [args.offset, args.limit]) {
				if (number !== undefined && (!Number.isSafeInteger(number) || number <= 0)) {
					throw new HarnessError("Read offset and limit must be positive integers");
				}
			}
			try {
				return await read.execute(id, { ...args, path: realFile(relative) }, signal, update);
			} catch {
				throw new HarnessError(`Could not read synthetic file ${relative}`);
			}
		},
	};
	const schema = Type.Object({
		label: Type.String({ description: "Brief description of the search" }),
		query: Type.String({ minLength: 1, maxLength: 100, description: "Literal, case-insensitive substring" }),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Maximum path and line hits" })),
	});
	const search: AgentTool<typeof schema> & { capabilities: readonly ["fs:read"] } = {
		name: "memory_search",
		label: "memory_search",
		description:
			"Find literal text in the synthetic Markdown memory files. Returns matching paths, line numbers, and excerpts.",
		capabilities: ["fs:read"],
		parameters: schema,
		async execute(_id, args, signal) {
			const query = args.query.trim().toLowerCase();
			if (!query || /[\r\n]/.test(query)) throw new HarnessError("Search requires a nonempty single line");
			const hits: string[] = [];
			const limit = args.limit ?? 6;
			for (const relative of allowed) {
				signal?.throwIfAborted();
				const lines = readFileSync(realFile(relative), "utf-8").split("\n");
				for (const [index, line] of lines.entries()) {
					const start = line.toLowerCase().indexOf(query);
					if (start >= 0)
						hits.push(`${relative}:${index + 1}: ${line.slice(Math.max(0, start - 48), start + 160)}`);
					if (hits.length === limit) break;
				}
				if (hits.length === limit) break;
			}
			return { content: [{ type: "text", text: hits.join("\n") || "No matches in synthetic memory" }], details: {} };
		},
	};
	return {
		executor: { exec: host.exec.bind(host), getWorkspacePath: () => WORKSPACE },
		tools: [safeRead, search],
		deniedCalls,
		readPath,
	};
}

function environment(route: Route, scratch: string): string | undefined {
	const key =
		route === "faux"
			? undefined
			: route === "deepseek"
				? (process.env.LIGHTCLAW_EVAL_DEEPSEEK_API_KEY ?? process.env.LIGHTCLAW_EVAL_API_KEY)
				: process.env.LIGHTCLAW_EVAL_API_KEY;
	for (const name of Object.keys(process.env)) {
		if ((name.startsWith("LIGHTCLAW_") && !name.startsWith("LIGHTCLAW_EVAL_")) || name.startsWith("PI_")) {
			delete process.env[name];
		}
	}
	process.env.LIGHTCLAW_CONTROL_DIR = join(scratch, "control");
	process.env.PI_CODING_AGENT_DIR = join(scratch, "pi");
	return key;
}

function liveModel(route: Exclude<Route, "faux">, scratch: string, key: string | undefined): Model<Api> {
	if (!key?.trim()) throw new HarnessError("Set the dedicated evaluation API key before enabling a live route");
	const provider = route === "deepseek" ? "deepseek" : process.env.LIGHTCLAW_EVAL_PROVIDER;
	const id = process.env.LIGHTCLAW_EVAL_MODEL_ID;
	if (!provider || !id)
		throw new HarnessError("Set the evaluation model ID and, for a configured route, its provider");
	const customPath = process.env.LIGHTCLAW_EVAL_MODELS_FILE;
	let localModels: string | undefined;
	if (customPath) {
		const path = resolve(customPath);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > 262_144) throw new HarnessError("Use an explicit small evaluation models file");
		const body: unknown = JSON.parse(readFileSync(path, "utf-8"));
		JSON.stringify(body, (_key, value: unknown) => {
			if (typeof value === "string" && value.startsWith("!")) {
				throw new HarnessError("Command-backed model configuration is disallowed in the benchmark");
			}
			return value;
		});
		localModels = join(scratch, "models.json");
		writeFileSync(localModels, JSON.stringify(body), { mode: 0o600 });
	}
	const model = resolveModelRef(provider, id, process.env.LIGHTCLAW_EVAL_BASE_URL, localModels);
	if (!KEY_AUTH_APIS.has(model.api)) throw new HarnessError("Evaluation model API must use an explicit API key");
	const url = new URL(model.baseUrl);
	const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !local) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(route === "deepseek" && url.origin !== "https://api.deepseek.com")
	) {
		throw new HarnessError("Evaluation model endpoint is outside the route's allowed origin");
	}
	return model;
}

function fauxModel(turns: FauxTurn[] | undefined) {
	const faux = registerFauxProvider();
	faux.setResponses(
		(turns ?? [{ text: "UNKNOWN" }]).map((turn) => {
			if (turn.read)
				return fauxAssistantMessage(fauxToolCall("read", { label: "Read synthetic memory", ...turn.read }), {
					stopReason: "toolUse",
				});
			if (turn.search)
				return fauxAssistantMessage(
					fauxToolCall("memory_search", { label: "Search synthetic memory", ...turn.search }),
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage(turn.text ?? "UNKNOWN");
		}),
	);
	return faux.getModel();
}

function describePrompt(prompt: string) {
	const memoryHeading = "\n### Current Memory\n";
	const start = prompt.indexOf(memoryHeading);
	const end = prompt.lastIndexOf("\n## Tools\n");
	const estimate = (value: string) => Math.ceil([...value].length / 4);
	const describe = (name: string, value: string) => ({
		name,
		bytes: Buffer.byteLength(value),
		estimatedTokens: estimate(value),
	});
	return {
		estimateMethod: "ceil(unicode_code_points/4); heuristic, not provider tokenization",
		estimatedTokens: estimate(prompt),
		bytes: Buffer.byteLength(prompt),
		parts:
			start >= 0 && end > start
				? [
						describe("before_current_memory", prompt.slice(0, start + 1)),
						describe("current_memory", prompt.slice(start + 1, end)),
						describe("after_current_memory", prompt.slice(end)),
					]
				: [describe("system_prompt", prompt)],
	};
}

function observeModel(selected: Model<Api>, maxRounds: number) {
	const provider = getApiProvider(selected.api);
	if (!provider) throw new HarnessError("The selected model API has no registered Pi implementation");
	const calls: Array<{ message?: AssistantMessage }> = [];
	const toolCalls: ToolCall[] = [];
	const errors = new Map<string, boolean>();
	let systemPrompt: ReturnType<typeof describePrompt> | undefined;
	let budgetExhausted = false;
	const observe = (context: Context, dispatch: () => AssistantMessageEventStream) => {
		systemPrompt ??= describePrompt(context.systemPrompt ?? "");
		for (const message of context.messages) {
			if (message.role === "toolResult") errors.set(message.toolCallId, message.isError);
		}
		// Invalid tool requests can skip the Runner's valid-tool execution reservation.
		if (calls.length >= maxRounds) {
			budgetExhausted = true;
			const stream = createAssistantMessageEventStream();
			const error: AssistantMessage = {
				...fauxAssistantMessage([], {
					stopReason: "aborted",
					errorMessage: "Evaluation model round budget exhausted",
				}),
				api: selected.api,
				provider: selected.provider,
				model: selected.id,
			};
			stream.push({ type: "error", reason: "aborted", error });
			return stream;
		}
		const call: { message?: AssistantMessage } = {};
		calls.push(call);
		const stream = dispatch();
		void stream.result().then((message) => {
			call.message = message;
			for (const content of message.content) {
				if (content.type === "toolCall") toolCalls.push(structuredClone(content));
			}
		});
		return stream;
	};
	registerApiProvider({
		api: selected.api,
		stream: (model, context, options) =>
			observe(context, () => provider.stream(model, context, { ...options, maxRetries: 0 })),
		streamSimple: (model, context, options) =>
			observe(context, () => provider.streamSimple(model, context, { ...options, maxRetries: 0 })),
	});
	return {
		calls,
		toolCalls,
		errors,
		get systemPrompt() {
			return systemPrompt ?? null;
		},
		get budgetExhausted() {
			return budgetExhausted;
		},
	};
}

function readLines<T>(path: string): T[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as T)
		: [];
}

function sanitize(value: unknown, key: string | undefined, scratch: string): unknown {
	if (typeof value === "string") {
		return redactSecrets((key ? value.replaceAll(key, "[REDACTED]") : value).replaceAll(scratch, "[scratch]"));
	}
	if (Array.isArray(value)) return value.map((item) => sanitize(item, key, scratch));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([name, item]) => [sanitize(name, key, scratch), sanitize(item, key, scratch)]),
		);
	}
	return value;
}

async function evaluate(spec: RunSpec, scratch: string) {
	const channel = spec.channel ?? "channel";
	if (!SAFE_NAME.test(channel) || channel.length > 64) throw new HarnessError("Invalid synthetic channel ID");
	const limits = { ...DEFAULT_LIMITS, ...spec.limits };
	if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) {
		throw new HarnessError("Limits must be positive safe integers within the timer range");
	}
	const workspace = join(scratch, "workspace");
	const channelDir = join(workspace, channel);
	const controlChannelDir = join(scratch, "control", channel);
	mkdirSync(channelDir, { recursive: true, mode: 0o700 });
	const files = writeFixture(workspace, channel, spec.files);
	const key = environment(spec.model.route, scratch);
	if (spec.variant !== "S2") delete process.env.MEMORY_FEATURES;
	const route = spec.model.route;
	const model = route === "faux" ? fauxModel(spec.model.turns) : liveModel(route, scratch, key);
	// Runner prompt includes process.cwd() in host mode. Keep it stable and free of machine-specific paths.
	process.chdir("/");
	model.maxTokens = Math.min(model.maxTokens, limits.maxOutputTokens);
	const observation = observeModel(model, limits.maxToolCalls + 1);
	const dispatcher = route === "faux" ? undefined : initializeHttpTransport();
	const scope = memoryTools(workspace, channel, files);
	const config: LightClawConfig = {
		transport: "feishu",
		modelProvider: model.provider,
		modelId: model.id,
		auditPayloadMode: "off",
		maxGoalCycles: 8,
		maxGoalFailures: 2,
		maxStaleCycles: 2,
		maxRunToolCalls: limits.maxToolCalls,
		maxRunTokens: limits.maxInputTokens,
		modelAttemptTimeoutMs: limits.attemptTimeoutMs,
		maxRunDurationMs: limits.runTimeoutMs,
	};
	const sandbox = { type: "host" } as const;
	const goalOptions = { channelDir, controlChannelDir, limits: { maxCycles: 8, maxFailures: 2, maxStaleCycles: 2 } };
	const overrides = {
		model,
		apiKey: key ?? "faux-evaluation-only",
		tools: scope.tools,
		executor: scope.executor,
		inMemoryState: true,
		quiet: true,
	} satisfies AgentRunnerOverrides;
	const noop = async () => {};
	let response = "";
	const context: ChatContext = {
		message: {
			text: spec.prompt,
			rawText: spec.prompt,
			user: "fixture-user",
			userName: "fixture-user",
			channel,
			ts: "evaluation",
			attachments: [],
		},
		channels: [],
		users: [],
		respond: noop,
		replaceMessage: async (text) => {
			response = text;
		},
		respondInThread: noop,
		setTyping: noop,
		uploadFile: noop,
		setWorking: noop,
		deleteMessage: noop,
	};
	const variants = {
		S0: () => {
			const runner = createS0(sandbox, channel, channelDir, config, new GoalsS0(goalOptions), overrides);
			return {
				run: () => runner.run(context, new StoreS0({ workingDir: workspace })),
				dispose: () => runner.dispose(),
			};
		},
		S1: () => {
			const runner = createS1(sandbox, channel, channelDir, config, new GoalsS1(goalOptions), overrides);
			return {
				run: () => runner.run(context, new StoreS1({ workingDir: workspace })),
				dispose: () => runner.dispose(),
			};
		},
		S2: () => {
			const runner = createS2(sandbox, channel, channelDir, config, new GoalsS2(goalOptions), overrides);
			return {
				run: () => runner.run(context, new StoreS2({ workingDir: workspace })),
				dispose: () => runner.dispose(),
			};
		},
		T: () => {
			const runner = createT(sandbox, channel, channelDir, config, new GoalsT(goalOptions), overrides);
			return {
				run: () => runner.run(context, new StoreT({ workingDir: workspace })),
				dispose: () => runner.dispose(),
			};
		},
	};
	const started = performance.now();
	let result: AgentRunResult;
	try {
		const runner = variants[spec.variant]();
		try {
			result = await runner.run();
		} finally {
			runner.dispose();
		}
	} finally {
		await dispatcher?.close();
	}
	const latencyMs = Math.round(performance.now() - started);
	const audit = resolveAuditDirectory(workspace);
	const modelAudit = readLines<{ type: string; modelAttempt?: ModelAttempt }>(join(audit, "runs.jsonl")).filter(
		({ type, modelAttempt }) => type === "model_attempt" && modelAttempt !== undefined,
	);
	const attempts = modelAudit.flatMap(({ modelAttempt }, index) => {
		if (!modelAttempt) return [];
		const { usage, status } = modelAttempt;
		const reported = usage && usage.totalTokens > 0 ? usage : null;
		return [
			{
				input: reported?.input ?? null,
				cacheRead: reported?.cacheRead ?? null,
				cacheWrite: reported?.cacheWrite ?? null,
				output: reported?.output ?? null,
				cacheReadSource: !reported
					? "missing"
					: route === "faux"
						? "synthetic"
						: reported.cacheRead > 0
							? "pi-positive"
							: "pi-normalized-zero",
				cacheWriteSource: !reported
					? "missing"
					: route === "faux"
						? "synthetic"
						: reported.cacheWrite > 0
							? "pi-positive"
							: "pi-normalized-zero",
				stopReason: observation.calls[index]?.message?.stopReason ?? status,
				status,
			},
		];
	});
	const toolAudit = readLines<ToolAuditEvent>(join(audit, "tool-calls.jsonl"));
	const outcomes = new Map(
		toolAudit.filter((event) => event.outcome !== "started").map((event) => [event.toolCallId, event.outcome]),
	);
	const tools = observation.toolCalls.map(({ id, name, arguments: args }) => {
		const rawPath = args.path;
		const safeArgs =
			typeof rawPath === "string" && !scope.readPath(rawPath) && !fixturePath(rawPath, channel)
				? { ...args, path: "[outside synthetic fixture]" }
				: args;
		const error = observation.errors.get(id);
		return {
			name,
			args: safeArgs,
			status: scope.deniedCalls.has(id)
				? "blocked"
				: (outcomes.get(id) ?? (error === undefined ? "not_executed" : error ? "error" : "ok")),
		};
	});
	const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf-8")) as Record<
		Variant,
		unknown
	>;
	return sanitize(
		{
			variant: spec.variant,
			source: manifest[spec.variant],
			route,
			model: { provider: model.provider, id: model.id },
			response,
			stopReason: result.stopReason,
			budgetReason:
				result.budgetReason ??
				(observation.budgetExhausted ? "Evaluation model round budget exhausted" : undefined),
			systemPrompt: observation.systemPrompt,
			attempts,
			tools,
			rounds: observation.calls.length,
			latencyMs,
			usageSource: route === "faux" ? "synthetic-pi-faux" : "pi-runner-audit",
			usageIncomplete:
				!!result.usageIncomplete || attempts.length === 0 || attempts.some((attempt) => attempt.input === null),
			fixturesUnchanged: fixtureUnchanged(workspace, channel, spec.files),
		},
		key,
		scratch,
	);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "lightclaw-eval-")));
try {
	console.log = console.info = console.warn = console.error = () => {};
	const [mode, route, ...extra] = process.argv.slice(2);
	if (mode === "--preflight" && (route === "deepseek" || route === "configured") && extra.length === 0) {
		const key = environment(route, scratch);
		let model: Model<Api>;
		try {
			model = liveModel(route, scratch, key);
		} catch (error) {
			if (error instanceof HarnessError) throw error;
			throw new HarnessError("Could not resolve the evaluation model configuration");
		}
		const { provider, id, api, contextWindow } = model;
		const descriptor = sanitize({ provider, id, api, contextWindow }, key, scratch);
		process.stdout.write(`${JSON.stringify(descriptor)}\n`);
	} else if (mode === undefined) {
		const trace = await evaluate(await readSpec(), scratch);
		process.stdout.write(`${JSON.stringify(trace)}\n`);
	} else {
		throw new HarnessError("Invalid evaluation Runner command");
	}
} catch (error) {
	process.stderr.write(`${error instanceof HarnessError ? error.message : "Evaluation Runner failed"}\n`);
	process.exitCode = 1;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
