import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModels,
	getProviders,
	type ImageContent,
	type KnownProvider,
	type Model,
} from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { attachmentPathForChannel } from "./attachments.js";
import { featureEnabled, type LightClawConfig } from "./config.js";
import { createLightClawSettingsManager, syncLogToSessionManager } from "./context.js";
import { formatGoalPrompt } from "./goals/prompt.js";
import type { GoalStore } from "./goals/store.js";
import * as log from "./log.js";
import { formatRunError, splitAssistantContent } from "./presentation.js";
import { boundedRedactedText, diagnosticText } from "./redaction.js";
import { assertContextCapacity, writePromptDiagnostic } from "./resource-policy.js";
import { createExecutor, type Executor, type SandboxConfig } from "./sandbox.js";
import type { ChannelStore } from "./store.js";
import { OperationTimeoutError, withTimedChatContext } from "./timeouts.js";
import { createLightClawTools } from "./tools/index.js";
import type { ChatChannel, ChatContext, ChatUser } from "./transport.js";

export interface AgentRunResult {
	stopReason: string;
	errorMessage?: string;
	budgetReason?: string;
	deliveryError?: string;
	durationMs: number;
	toolCalls: number;
	verificationCommandCount: number;
	toolErrors: number;
	/** All input tokens, including provider-reported cache reads and writes. */
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(ctx: ChatContext, store: ChannelStore, pendingMessages?: PendingMessage[]): Promise<AgentRunResult>;
	abort(): void;
	dispose(): void;
	compact?(): Promise<void>;
}

export interface AgentRunnerOverrides {
	inMemoryState?: boolean;
	executor?: Executor;
	model?: Model<Api>;
	tools?: AgentTool[];
	apiKey?: string;
	quiet?: boolean;
	/** Sent only through the OpenAI-compatible API; provider determinism is not guaranteed. */
	evaluationSeed?: number;
}

type RunnerLogger = Pick<
	typeof log,
	| "logInfo"
	| "logWarning"
	| "logToolStart"
	| "logToolError"
	| "logToolSuccess"
	| "logResponseStart"
	| "logThinking"
	| "logResponse"
	| "logUsageSummary"
>;

const silentRunnerLogger: RunnerLogger = {
	logInfo: () => {},
	logWarning: () => {},
	logToolStart: () => {},
	logToolError: () => {},
	logToolSuccess: () => {},
	logResponseStart: () => {},
	logThinking: () => {},
	logResponse: () => {},
	logUsageSummary: () => "",
};

export function resolveModel(config: LightClawConfig): Model<Api> {
	if (!getProviders().includes(config.modelProvider as KnownProvider)) {
		throw new Error(`未知模型提供商：${config.modelProvider}`);
	}
	const source = getModels(config.modelProvider as KnownProvider).find((candidate) => candidate.id === config.modelId);
	if (!source) throw new Error(`找不到模型：${config.modelProvider}/${config.modelId}`);
	const model: Model<Api> = {
		...source,
		cost: { ...source.cost },
		headers: source.headers ? { ...source.headers } : undefined,
		compat: source.compat,
	};
	if (config.openaiBaseUrl) model.baseUrl = config.openaiBaseUrl;
	if (config.modelProvider === "zai" && model.api === "openai-completions") {
		const openAIModel = model as Model<"openai-completions">;
		openAIModel.compat = { ...openAIModel.compat, thinkingFormat: "openai", zaiToolStream: false };
	}
	return model;
}

export async function resolveApiKey(authStorage: AuthStorage, provider: string): Promise<string> {
	// Fall back to OPENAI_API_KEY: gateways usually issue one key regardless of
	// which upstream model is being routed to.
	const key = (await authStorage.getApiKey(provider)) ?? process.env.OPENAI_API_KEY;
	if (!key) {
		throw new Error(
			`No API key found for ${provider} (tried ${provider} auth and OPENAI_API_KEY).\n\n` +
				"Set OPENAI_API_KEY, or link to auth.json from " +
				join(homedir(), ".pi", "lightclaw", "auth.json"),
		);
	}
	return key;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getMemory(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function loadLightClawSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	// channelDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
	// hostWorkspacePath is the parent directory on host
	// workspacePath is the container path (e.g., /workspace)
	const hostWorkspacePath = join(channelDir, "..");

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		// Translate paths to container paths for system prompt
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function buildWorkspaceGuide(workspacePath: string, channelId: string): string {
	const channelPath = `${workspacePath}/${channelId}`;
	return `## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to Slack. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Authorized environment changes and project dependencies
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
Check command availability before using jq; do not install system packages in Docker.

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

`;
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChatChannel[],
	users: ChatUser[],
	skills: Skill[],
	goalStore: GoalStore,
	transport: LightClawConfig["transport"],
	promptInstructions?: string,
	capabilities?: string,
	goalsEnabled = true,
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	// Format channel mappings
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	// Format user mappings
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: /workspace
- You are a non-root user and cannot install system packages at runtime.
- If another system package is required, explain which package is missing instead of attempting privilege escalation.
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `You are LightClaw, a ${transport} personal agent. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Formatting
Messages are sent as plain text and are NOT rendered as Markdown.
Do NOT use markdown syntax (**bold**, [links](url), headings) — write plain sentences with line breaks.

## Known Users
Channels: ${channelMappings}

Users: ${userMappings}

When you want to address a user, write their name directly — do not use <@...> mention syntax.

## Environment
${envDescription}
${capabilities ?? "Optional commands are not verified. Check command -v before using commands such as file; use available alternatives for encoding checks. Do not assume a command exists."}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all channels)
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools

## Skills and Events
Available skills: ${skills.length > 0 ? formatSkillsForPrompt(skills) : "(none installed)"}
Before creating skills, scheduling/managing events, querying older logs, or restoring environment configuration, read ${channelPath}/.lightclaw-guide.md using the read tool. It contains the full formats and examples. These capabilities remain available; ordinary file tasks do not require reading this guide.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## Tools
- bash: Run shell commands (primary tool). Check available commands; respect the environment package-install restrictions.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to the current chat

Each tool requires a "label" parameter (shown to user).
${goalsEnabled ? formatGoalPrompt(goalStore.get()) : ""}
${promptInstructions ? `\n## 可迭代行为指令\n${promptInstructions}` : ""}`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArguments(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a channel.
 * Runners are cached - one per channel, persistent across messages.
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	config: LightClawConfig,
	goalStore: GoalStore,
	overrides: AgentRunnerOverrides = {},
): AgentRunner {
	const key = resolve(channelDir);
	const existing = channelRunners.get(key);
	if (existing) return existing;

	const runner = createAgentRunner(sandboxConfig, channelId, channelDir, config, goalStore, overrides);
	channelRunners.set(key, runner);
	return runner;
}

export function releaseRunner(channelDir: string): void {
	const key = resolve(channelDir);
	const runner = channelRunners.get(key);
	if (!runner) return;
	runner.dispose();
	channelRunners.delete(key);
}

/**
 * Create a new AgentRunner for a channel.
 * Sets up the session and subscribes to events once.
 */
export function createAgentRunner(
	requestedSandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	config: LightClawConfig,
	goalStore: GoalStore,
	overrides: AgentRunnerOverrides = {},
): AgentRunner {
	const sandboxConfig: SandboxConfig = featureEnabled(config, "infrastructure")
		? requestedSandboxConfig
		: { type: "host" };
	const controlsEnabled = featureEnabled(config, "controls");
	const promptInstructions = featureEnabled(config, "optimization") ? config.promptInstructions : undefined;
	const runnerLog: RunnerLogger = overrides.quiet ? silentRunnerLogger : log;
	const executor = overrides.executor ?? createExecutor(sandboxConfig, config.bashTimeoutSeconds ?? 120);
	const model = overrides.model ?? resolveModel(config);
	const workspacePath = executor.getWorkspacePath(channelDir.replace(`/${channelId}`, ""));
	let running = false;
	let disposed = false;
	let permittedTools = 0;
	let budgetReason: string | undefined;
	let abortRequested = false;
	let verificationAbort = new AbortController();
	let deadline = 0;
	let verificationCommandCount = 0;

	// Create tools
	const allTools =
		overrides.tools ??
		createLightClawTools(
			executor,
			goalStore,
			async (filePath, title) => {
				const ctx = runState.ctx;
				if (!ctx) throw new Error("Attachments require an active run");
				const relativePath = attachmentPathForChannel(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(relativePath, title);
			},
			() => {
				assertRunActive();
				return {
					channelDir,
					sandbox: sandboxConfig,
					executor,
					signal: verificationAbort.signal,
					assertActive: assertRunActive,
					reserveCommand: () => {
						reserveToolExecution();
						verificationCommandCount++;
						runState.toolCalls++;
						return { timeoutSeconds: Math.min(config.bashTimeoutSeconds ?? 120, (deadline - Date.now()) / 1000) };
					},
				};
			},
		);

	const tools = featureEnabled(config, "goals") ? allTools : allTools.filter((tool) => !tool.name.startsWith("goal_"));

	// Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
	const memory = getMemory(channelDir);
	const skills = loadLightClawSkills(channelDir, workspacePath);
	let capabilities: string | undefined;
	let systemPrompt = buildSystemPrompt(
		workspacePath,
		channelId,
		memory,
		sandboxConfig,
		[],
		[],
		skills,
		goalStore,
		config.transport,
		promptInstructions,
		undefined,
		featureEnabled(config, "goals"),
	);

	// Create session manager and settings manager
	// Use a fixed context.jsonl file per channel (not timestamped like coding-agent)
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = overrides.inMemoryState
		? SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 64 } })
		: createLightClawSettingsManager(join(channelDir, ".."));

	// Create AuthStorage and ModelRegistry
	// Auth stored outside workspace so agent can't access it
	const authStorage = overrides.inMemoryState
		? AuthStorage.inMemory()
		: AuthStorage.create(join(homedir(), ".pi", "lightclaw", "auth.json"));
	if (overrides.apiKey !== undefined) authStorage.setRuntimeApiKey(model.provider, overrides.apiKey);
	const modelRegistry = overrides.inMemoryState
		? ModelRegistry.inMemory(authStorage)
		: ModelRegistry.create(authStorage);

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey:
			overrides.apiKey !== undefined
				? () => overrides.apiKey
				: async () => resolveApiKey(authStorage, model.provider),
	});

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.state.messages = loadedSession.messages;
		runnerLog.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: sandboxConfig.type === "docker" ? workspacePath : process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});
	const cancelRun = () => {
		abortRequested = true;
		verificationAbort.abort();
		session.abortRetry();
		session.abortCompaction();
		agent.abort();
	};
	const exhaustBudget = (reason: string) => {
		if (budgetReason) return;
		budgetReason = reason;
		cancelRun();
	};
	const streamModel = agent.streamFn;
	agent.streamFn = (requestModel, context, options) => {
		if (!abortRequested && !budgetReason && !options?.signal?.aborted) {
			if (overrides.evaluationSeed === undefined) return streamModel(requestModel, context, options);
			if (requestModel.api !== "openai-completions")
				throw new Error("当前 API 不支持本评估器的 seed 注入；不能声称已完成多种子评估");
			return streamModel(requestModel, context, {
				...options,
				onPayload: async (payload, selectedModel) => {
					const updated = (await options?.onPayload?.(payload, selectedModel)) ?? payload;
					if (typeof updated !== "object" || updated === null || Array.isArray(updated))
						throw new Error("seed 需要对象形式的请求载荷");
					return { ...updated, seed: overrides.evaluationSeed };
				},
			});
		}
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: budgetReason ?? "Run cancelled before model dispatch",
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "aborted", error: message });
		stream.end(message);
		return stream;
	};
	const assertRunActive = () => {
		if (!running || disposed || abortRequested || verificationAbort.signal.aborted)
			throw new Error("Run cancelled before verification");
		if (controlsEnabled && Date.now() >= deadline) exhaustBudget("Run duration budget exhausted");
		if (budgetReason) throw new Error(budgetReason);
	};
	const reserveToolExecution = () => {
		assertRunActive();
		if (controlsEnabled && permittedTools >= (config.maxRunToolCalls ?? 100))
			exhaustBudget(`Run tool call budget exhausted (${config.maxRunToolCalls ?? 100})`);
		assertRunActive();
		permittedTools++;
	};
	const beforeToolCall = agent.beforeToolCall;
	agent.beforeToolCall = async (context, signal) => {
		try {
			reserveToolExecution();
		} catch (error) {
			return { block: true, reason: budgetReason ?? String(error) };
		}
		return beforeToolCall?.(context, signal);
	};

	// Mutable per-run state - event handler references this
	const runState = {
		ctx: null as ChatContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
		toolCalls: 0,
		toolErrors: 0,
		terminalGoalText: undefined as string | undefined,
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		// Skip if no active run
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			runState.toolCalls++;
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			runnerLog.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			queue.enqueue(() => ctx.respond(`_→ ${boundedRedactedText(agentEvent.toolName, 128)}_`, false), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (!agentEvent.isError && agentEvent.toolName === "goal_complete" && agentEvent.result.terminate) {
				const outcome = agentEvent.result.details;
				if (
					typeof outcome === "object" &&
					outcome !== null &&
					"committed" in outcome &&
					outcome.committed === true
				) {
					const goal = goalStore.get();
					if (goal?.status === "completed" || goal?.status === "awaiting_confirmation")
						runState.terminalGoalText = `${resultStr}\n${goal.lastProgress ?? ""}`.trim();
				}
			}

			if (agentEvent.isError) {
				runState.toolErrors++;
				runnerLog.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				runnerLog.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			// Post args + result to thread
			const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
			const argsFormatted = pending
				? formatToolArguments(agentEvent.toolName, pending.args as Record<string, unknown>)
				: "(args not found)";
			const duration = (durationMs / 1000).toFixed(1);
			let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
			if (label) threadMessage += `: ${diagnosticText(label)}`;
			threadMessage += ` (${duration}s)\n`;
			if (argsFormatted) threadMessage += `\`\`\`\n${diagnosticText(argsFormatted)}\n\`\`\`\n`;
			threadMessage += `*Result:*\n\`\`\`\n${diagnosticText(resultStr)}\n\`\`\``;

			queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${diagnosticText(resultStr)}_`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				runnerLog.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as AssistantMessage;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
					const tokens =
						runState.totalUsage.input +
						runState.totalUsage.output +
						runState.totalUsage.cacheRead +
						runState.totalUsage.cacheWrite;
					if (controlsEnabled && tokens >= (config.maxRunTokens ?? 100_000)) {
						exhaustBudget(`Run token budget exhausted (${tokens} >= ${config.maxRunTokens ?? 100_000})`);
					}
				}

				const { text, thinking } = splitAssistantContent(assistantMsg.content);
				for (const detail of thinking) {
					runnerLog.logThinking(logCtx, detail);
				}

				if (text.trim()) {
					runnerLog.logResponse(logCtx, text);
					queue.enqueueMessage(text, "main", "response main");
					queue.enqueueMessage(text, "thread", "response thread", false);
				}
			}
		} else if (event.type === "compaction_start") {
			runnerLog.logInfo(`Compaction started (reason: ${event.reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "compaction_end") {
			if (event.result) {
				runnerLog.logInfo(`Compaction complete: ${event.result.tokensBefore} tokens compacted`);
			} else if (event.aborted) {
				runnerLog.logInfo("Compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			runnerLog.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	});

	const messageLengthLimit = config.transport === "slack" ? 40_000 : 25_000;
	const splitMessage = (text: string): string[] => {
		if (text.length <= messageLengthLimit) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, messageLengthLimit - 50);
			remaining = remaining.substring(messageLengthLimit - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async run(
			inputContext: ChatContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<AgentRunResult> {
			if (disposed) throw new Error(`Agent runner is disposed for channel ${channelId}`);
			if (running) throw new Error(`Agent runner is already running for channel ${channelId}`);
			running = true;
			permittedTools = 0;
			budgetReason = undefined;
			abortRequested = false;
			verificationAbort = new AbortController();
			verificationCommandCount = 0;
			deadline = controlsEnabled ? Date.now() + (config.maxRunDurationMs ?? 300_000) : Number.POSITIVE_INFINITY;
			let deliveryError: string | undefined;
			const ctx = withTimedChatContext(inputContext, config.platformTimeoutMs ?? 30_000, (error) => {
				deliveryError ??= error.message;
				if (error instanceof OperationTimeoutError) cancelRun();
			});
			let budgetTimer: NodeJS.Timeout | undefined;
			let queueChain = Promise.resolve();
			try {
				const startedAt = Date.now();
				// Ensure channel directory exists
				await mkdir(channelDir, { recursive: true });
				assertContextCapacity(channelDir, Buffer.byteLength(ctx.message.text));

				// Sync messages from log.jsonl that arrived while we were offline or busy
				// Exclude the current message (it will be added via prompt())
				const syncedCount = syncLogToSessionManager(sessionManager, channelDir, ctx.message.ts);
				if (syncedCount > 0) {
					runnerLog.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
				}

				// Reload messages from context.jsonl
				// This picks up any messages synced above
				const reloadedSession = sessionManager.buildSessionContext();
				if (reloadedSession.messages.length > 0) {
					agent.state.messages = reloadedSession.messages;
					runnerLog.logInfo(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
				}

				// Update system prompt with fresh memory, channel/user info, and skills
				const memory = getMemory(channelDir);
				const skills = loadLightClawSkills(channelDir, workspacePath);
				if (capabilities === undefined && overrides.tools === undefined) {
					try {
						const commands = ["bash", "curl", "git", "jq", "python3", "file"];
						const probe = await executor.exec(
							`for tool in ${commands.join(" ")}; do if command -v "$tool" >/dev/null 2>&1; then printf "%s\\n" "$tool"; fi; done`,
							{ timeout: 5, signal: verificationAbort.signal },
						);
						if (probe.code === 0) {
							const available = new Set(probe.stdout.trim().split(/\s+/));
							capabilities = `Available optional commands (checked): ${commands.filter((name) => available.has(name)).join(", ") || "none"}.\nUnavailable optional commands (checked): ${commands.filter((name) => !available.has(name)).join(", ") || "none"}. Do not invoke missing commands; use available alternatives. Other commands are unverified: check command -v before use. Do not install system packages in Docker.`;
						}
					} catch {
						capabilities =
							"Command discovery failed. Check command -v before using optional commands; do not assume they exist.";
					}
				}
				await writeFile(
					join(channelDir, ".lightclaw-guide.md"),
					buildWorkspaceGuide(workspacePath, channelId),
					"utf8",
				);
				systemPrompt = buildSystemPrompt(
					workspacePath,
					channelId,
					memory,
					sandboxConfig,
					ctx.channels,
					ctx.users,
					skills,
					goalStore,
					config.transport,
					promptInstructions,
					capabilities,
					featureEnabled(config, "goals"),
				);
				const activeGoal = featureEnabled(config, "goals") && goalStore.get()?.status === "active";
				session.setActiveToolsByName(
					tools.filter((tool) => activeGoal || !tool.name.startsWith("goal_")).map((tool) => tool.name),
				);

				// Reset per-run state
				runState.ctx = ctx;
				runState.logCtx = {
					channelId: ctx.message.channel,
					userName: ctx.message.userName,
					channelName: ctx.channelName,
				};
				runState.pendingTools.clear();
				runState.totalUsage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				runState.stopReason = "stop";
				runState.errorMessage = undefined;
				runState.terminalGoalText = undefined;
				runState.toolCalls = 0;
				runState.toolErrors = 0;

				// Create queue for this run
				runState.queue = {
					enqueue(fn: () => Promise<void>, errorContext: string): void {
						queueChain = queueChain.then(async () => {
							try {
								await fn();
							} catch (err) {
								const errMsg = err instanceof Error ? err.message : String(err);
								runnerLog.logWarning(`Chat API error (${errorContext})`, errMsg);
								try {
									await ctx.respondInThread(`_Error: ${diagnosticText(errMsg)}_`);
								} catch {
									// Ignore
								}
							}
						});
					},
					enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
						const parts = splitMessage(text);
						for (const part of parts) {
							this.enqueue(
								() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
								errorContext,
							);
						}
					},
				};

				// Log context info
				runnerLog.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
				runnerLog.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

				// Build user message with timestamp and username prefix
				// Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
				const now = new Date();
				const pad = (n: number) => n.toString().padStart(2, "0");
				const offset = -now.getTimezoneOffset();
				const offsetSign = offset >= 0 ? "+" : "-";
				const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
				const offsetMins = pad(Math.abs(offset) % 60);
				const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
				let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

				const imageAttachments: ImageContent[] = [];
				const nonImagePaths: string[] = [];

				for (const a of ctx.message.attachments || []) {
					const fullPath = `${workspacePath}/${a.local}`;
					const mimeType = getImageMimeType(a.local);

					if (mimeType && existsSync(fullPath)) {
						try {
							imageAttachments.push({
								type: "image",
								mimeType,
								data: readFileSync(fullPath).toString("base64"),
							});
						} catch {
							nonImagePaths.push(fullPath);
						}
					} else {
						nonImagePaths.push(fullPath);
					}
				}

				if (nonImagePaths.length > 0) {
					userMessage += `\n\n<chat_attachments>\n${nonImagePaths.join("\n")}\n</chat_attachments>`;
				}

				// Debug: write context to last_prompt.jsonl
				const debugContext = {
					systemPrompt: session.systemPrompt,
					messages: session.messages,
					newUserMessage: userMessage,
					imageAttachmentCount: imageAttachments.length,
				};
				writePromptDiagnostic(channelDir, debugContext);

				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) exhaustBudget("Run duration budget exhausted during setup");
				else if (!abortRequested) {
					if (controlsEnabled)
						budgetTimer = setTimeout(
							() => exhaustBudget(`Run duration budget exhausted (${config.maxRunDurationMs ?? 300_000}ms)`),
							remainingMs,
						);
					assertContextCapacity(channelDir, Buffer.byteLength(userMessage));
					await session.prompt(
						userMessage,
						imageAttachments.length > 0 ? { images: imageAttachments } : undefined,
					);
				}
				if (budgetTimer) {
					clearTimeout(budgetTimer);
					budgetTimer = undefined;
				}
				if (budgetReason) {
					runState.stopReason = "aborted";
					runState.errorMessage = budgetReason;
				}
				if (abortRequested) runState.stopReason = "aborted";
				// A committed terminating tool ends a successful run without a final model message.
				// Keep the provider's original toolUse event in the persisted session.
				if (runState.stopReason === "toolUse" && runState.terminalGoalText && !abortRequested && !budgetReason)
					runState.stopReason = "stop";

				// Wait for queued messages
				await queueChain;

				// Handle error case - update main message and post error to thread
				if ((runState.stopReason === "error" || budgetReason) && runState.errorMessage) {
					try {
						const presentation = formatRunError(
							boundedRedactedText(runState.errorMessage),
							goalStore.get()?.status === "completed",
						);
						await ctx.replaceMessage(presentation.message);
						if (presentation.detail) await ctx.respondInThread(`错误：${diagnosticText(presentation.detail)}`);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						runnerLog.logWarning("Failed to post error message", errMsg);
					}
				} else {
					// Final message update
					const messages = session.messages;
					const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
					const finalText =
						lastAssistant?.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n") ||
						runState.terminalGoalText ||
						"";

					// Check for [SILENT] marker - delete message and thread instead of posting
					if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
						try {
							await ctx.deleteMessage();
							runnerLog.logInfo("Silent response - deleted message and thread");
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							runnerLog.logWarning("Failed to delete message for silent response", errMsg);
						}
					} else if (finalText.trim()) {
						try {
							const mainText =
								finalText.length > messageLengthLimit
									? `${finalText.substring(0, messageLengthLimit - 50)}\n\n_(see thread for full response)_`
									: finalText;
							await ctx.replaceMessage(mainText);
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							runnerLog.logWarning("Failed to replace message with final text", errMsg);
						}
					}
				}

				// Log usage summary with context info
				if (runState.totalUsage.cost.total > 0) {
					// Get last non-aborted assistant message for context calculation
					const messages = session.messages;
					const lastAssistantMessage = messages
						.slice()
						.reverse()
						.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

					const contextTokens = lastAssistantMessage
						? lastAssistantMessage.usage.input +
							lastAssistantMessage.usage.output +
							lastAssistantMessage.usage.cacheRead +
							lastAssistantMessage.usage.cacheWrite
						: 0;
					const contextWindow = model.contextWindow || 200000;

					const summary = runnerLog.logUsageSummary(
						runState.logCtx!,
						runState.totalUsage,
						contextTokens,
						contextWindow,
					);
					runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
					await queueChain;
				}

				return {
					stopReason: runState.stopReason,
					errorMessage: runState.errorMessage,
					budgetReason,
					deliveryError,
					durationMs: Date.now() - startedAt,
					toolCalls: runState.toolCalls,
					verificationCommandCount,
					toolErrors: runState.toolErrors,
					inputTokens: runState.totalUsage.input + runState.totalUsage.cacheRead + runState.totalUsage.cacheWrite,
					outputTokens: runState.totalUsage.output,
					cost: runState.totalUsage.cost.total,
				};
			} finally {
				if (budgetTimer) clearTimeout(budgetTimer);
				try {
					await queueChain;
				} finally {
					runState.ctx = null;
					runState.logCtx = null;
					runState.queue = null;
					runState.pendingTools.clear();
					running = false;
				}
			}
		},

		async compact(): Promise<void> {
			if (running || disposed) throw new Error("Compaction requires an idle active runner");
			await session.compact();
		},

		abort(): void {
			cancelRun();
		},
		dispose(): void {
			if (disposed) return;
			if (running) throw new Error(`Cannot dispose a running agent for channel ${channelId}`);
			session.dispose();
			disposed = true;
		},
	};
}
