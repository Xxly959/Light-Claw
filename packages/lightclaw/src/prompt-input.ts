import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Api, completeSimple, type Model, type Usage } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { resolveApiKey, resolveModel } from "./agent.js";
import type { LightClawConfig } from "./config.js";
import { stableId, writeDurableJson } from "./durable-state.js";
import { physicalPath } from "./goals/control.js";
import { EMPTY_MODEL_RESPONSE_ERROR } from "./model-response.js";
import {
	DEFAULT_REWRITE_TARGET,
	type PromptRewriteResult,
	parseRewrite,
	REVIEW_SYSTEM,
	REWRITE_SYSTEM,
	type RewriteTarget,
	validateProtectedLiterals,
	validateReview,
} from "./prompt-rewrite.js";
import { OperationTimeoutError } from "./timeouts.js";
import type { ChatEvent } from "./transport.js";

const PROMPT_FAILURE_MESSAGES = {
	timeout: "提示词优化超时，尚未执行任务。",
	cancelled: "提示词处理已取消，尚未执行任务。",
	format: "模型返回的优化提示词格式不符合要求。",
	empty_response: "模型返回空响应，提示词优化未完成，尚未执行任务；请联系管理员核对接口。",
	incomplete: "模型未完整返回优化提示词，尚未执行任务。",
	expired: "这张输入表单已过期。",
	submitted: "这张输入表单已提交或中断，不能重复使用。",
	forbidden: "仅创建者能在原群的原始表单提交。",
	entry_invalid: "请在原群的原始任务入口操作，不支持转发卡片。",
	busy: "频道正在处理另一项任务，请结束后再提交。",
	goal_active: "请先暂停当前长期目标，再提交独立任务。",
	unavailable: "提示词表单或优化功能当前不可用。",
	review: "候选未通过原意与约束检查，尚未执行任务。",
	failed: "提示词处理失败，尚未执行任务；请联系管理员核对。",
} as const;
export type PromptFailureCode = keyof typeof PROMPT_FAILURE_MESSAGES;
/** Fixed public messages only: never forward provider errors or diagnostic placeholders. */
export function describePromptFailure(
	error: unknown,
	state: { timedOut?: boolean; cancelled?: boolean } = {},
): { code: PromptFailureCode; message: string } {
	let code: PromptFailureCode = "failed";
	const message = error instanceof Error ? error.message : "";
	if (state.timedOut || error instanceof OperationTimeoutError) code = "timeout";
	else if (
		state.cancelled ||
		(error instanceof Error && error.name === "AbortError") ||
		message === "停止期间不执行提示词"
	)
		code = "cancelled";
	else if (message === "提示词候选未通过约束复核" || message === "提示词改写未保留原文材料或数字约束") code = "review";
	else if (message === EMPTY_MODEL_RESPONSE_ERROR) code = "empty_response";
	else if (["提示词改写输出格式无效", "提示词改写结果为空或过长"].includes(message)) code = "format";
	else if (/^提示词改写未完成：(stop|length|toolUse|error|aborted)$/.test(message)) code = "incomplete";
	else if (message === "提示词表单已过期，请重新打开 /prompt") code = "expired";
	else if (message === "重复或中断的提交不自动重试，请重新打开 /prompt") code = "submitted";
	else if (message === "仅原始发送者可在原频道卡片提交") code = "forbidden";
	else if (message === "请在原群的原始任务入口卡片操作") code = "entry_invalid";
	else if (message === "频道正在运行，请结束后重新打开 /prompt") code = "busy";
	else if (message === "请先暂停当前长期目标，再提交独立提示词") code = "goal_active";
	else if (["提示词表单不可用", "提示词优化功能已关闭", "当前入口不支持提示词表单"].includes(message))
		code = "unavailable";
	return { code, message: PROMPT_FAILURE_MESSAGES[code] };
}

interface PromptEntry {
	schema: 1;
	id: string;
	channel: string;
	messageId?: string;
}
/** Reusable navigation only; execution still requires a fresh, actor-bound draft. */
export class PromptEntryStore {
	private readonly directory: string;
	constructor(directory: string) {
		this.directory = physicalPath(directory);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
	}
	private path(id: string): string {
		if (!/^[a-f0-9]{64}$/.test(id) || physicalPath(this.directory) !== this.directory)
			throw new Error("非法任务入口路径");
		return join(this.directory, `${id}.json`);
	}
	private read(id: string): PromptEntry | undefined {
		const path = this.path(id);
		if (!existsSync(path)) return;
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16000) throw new Error("非法任务入口记录");
		const value = JSON.parse(readFileSync(path, "utf8")) as PromptEntry;
		if (
			value.schema !== 1 ||
			value.id !== id ||
			typeof value.channel !== "string" ||
			(value.messageId !== undefined && typeof value.messageId !== "string")
		)
			throw new Error("任务入口记录损坏");
		return value;
	}
	create(event: ChatEvent): PromptEntry {
		if (event.origin !== "platform" || !event.user || !event.channel) throw new Error("任务入口须由平台用户创建");
		const id = stableId("prompt-entry", event.channel, event.ts);
		const existing = this.read(id);
		if (existing) {
			if (existing.channel !== event.channel) throw new Error("任务入口身份冲突");
			return existing;
		}
		const entry: PromptEntry = { schema: 1, id, channel: event.channel };
		writeDurableJson(this.path(id), entry);
		return entry;
	}
	bind(id: string, messageId: string): void {
		const entry = this.read(id);
		if (!entry || entry.messageId || !messageId) throw new Error("任务入口已绑定或不存在");
		writeDurableJson(this.path(id), { ...entry, messageId });
	}
	assertBound(id: string, channel: string, messageId: string): void {
		const entry = this.read(id);
		if (!entry?.messageId || entry.channel !== channel || entry.messageId !== messageId)
			throw new Error("请在原群的原始任务入口卡片操作");
	}
}

interface PromptDraft {
	schema: 2;
	optimize?: boolean;
	effectiveInput?: string;
	rewriteDetails?: Omit<PromptRewriteResult, "prompt">;
	failureCode?: PromptFailureCode;
	id: string;
	user: string;
	channel: string;
	input: string;
	expiresAt: number;
	status: "offered" | "running" | "preview" | "consumed" | "failed";
	messageId?: string;
}
/** Protected by the runtime's single-instance lock. A claimed request is never automatically replayed. */
export class PromptDraftStore {
	private readonly directory: string;
	constructor(directory: string) {
		this.directory = physicalPath(directory);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
	}
	private path(id: string) {
		if (!/^[a-f0-9]{64}$/.test(id) || physicalPath(this.directory) !== this.directory)
			throw new Error("非法提示词记录路径");
		return join(this.directory, `${id}.json`);
	}
	private read(id: string): PromptDraft | undefined {
		const path = this.path(id);
		if (!existsSync(path)) return;
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128000) throw new Error("非法提示词记录");
		const value = JSON.parse(readFileSync(path, "utf8")) as PromptDraft;
		if (
			value.schema !== 2 ||
			value.id !== id ||
			typeof value.input !== "string" ||
			typeof value.user !== "string" ||
			typeof value.channel !== "string" ||
			!Number.isFinite(value.expiresAt) ||
			!["offered", "running", "preview", "consumed", "failed"].includes(value.status)
		)
			throw new Error("提示词记录损坏");
		return value;
	}
	create(event: ChatEvent, now = Date.now()): PromptDraft {
		if (event.origin !== "platform" || !event.user || !event.channel || event.text.length > 1000)
			throw new Error("表单初始输入必须为最多1000字符的平台原文");
		const id = stableId("prompt-composer-v2", event.channel, event.user, event.ts);
		const existing = this.read(id);
		if (existing) {
			if (existing.input !== event.text) throw new Error("提示词身份冲突");
			return existing;
		}
		const draft: PromptDraft = {
			schema: 2,
			id,
			user: event.user,
			channel: event.channel,
			input: event.text,
			expiresAt: now + 1800000,
			status: "offered",
		};
		writeDurableJson(this.path(id), draft);
		return draft;
	}
	bindCard(id: string, messageId: string) {
		const draft = this.read(id);
		if (!draft || draft.status !== "offered" || draft.messageId) throw new Error("卡片已绑定或不存在");
		writeDurableJson(this.path(id), { ...draft, messageId });
	}
	claim(
		id: string,
		user: string,
		channel: string,
		messageId: string,
		input: string,
		optimize: boolean,
		now = Date.now(),
	): PromptDraft {
		const draft = this.read(id);
		if (!draft || draft.user !== user || draft.channel !== channel || draft.messageId !== messageId)
			throw new Error("仅原始发送者可在原频道卡片提交");
		if (draft.expiresAt <= now) throw new Error("提示词表单已过期，请重新打开 /prompt");
		if (draft.status !== "offered") throw new Error("重复或中断的提交不自动重试，请重新打开 /prompt");
		if (typeof input !== "string" || !input.trim() || input.length > 1000 || typeof optimize !== "boolean")
			throw new Error("提示词须为1至1000字符，且发送模式必须明确");
		const claimed: PromptDraft = { ...draft, input, optimize, status: "running" };
		writeDurableJson(this.path(id), claimed);
		return claimed;
	}
	preview(id: string, effectiveInput: string, rewriteDetails?: PromptRewriteResult): void {
		const draft = this.read(id);
		if (
			!draft ||
			draft.status !== "running" ||
			!draft.optimize ||
			!effectiveInput.trim() ||
			effectiveInput.length > 12000
		)
			throw new Error("提示词预览状态或内容无效");
		const metadata = rewriteDetails
			? {
					taskType: rewriteDetails.taskType,
					changes: rewriteDetails.changes,
					assumptions: rewriteDetails.assumptions,
					openQuestions: rewriteDetails.openQuestions,
				}
			: undefined;
		writeDurableJson(this.path(id), { ...draft, effectiveInput, rewriteDetails: metadata, status: "preview" });
	}
	confirm(id: string, user: string, channel: string, messageId: string, input: string, now = Date.now()): PromptDraft {
		const draft = this.read(id);
		if (!draft || draft.user !== user || draft.channel !== channel || draft.messageId !== messageId)
			throw new Error("仅原始发送者可在原频道卡片提交");
		if (draft.expiresAt <= now) throw new Error("提示词表单已过期，请重新打开 /prompt");
		if (draft.status !== "preview" || !draft.optimize || !draft.effectiveInput)
			throw new Error("重复或中断的提交不自动重试，请重新打开 /prompt");
		if (typeof input !== "string" || !input.trim() || input.length > 12000)
			throw new Error("确认提示词须为1至12000字符");
		const confirmed: PromptDraft = { ...draft, effectiveInput: input, status: "running" };
		writeDurableJson(this.path(id), confirmed);
		return confirmed;
	}
	consume(id: string, effectiveInput: string) {
		const draft = this.read(id);
		if (
			!draft ||
			draft.status !== "running" ||
			!effectiveInput.trim() ||
			effectiveInput.length > 12000 ||
			(draft.optimize && draft.effectiveInput !== effectiveInput)
		)
			throw new Error("提示词提交状态或内容无效");
		writeDurableJson(this.path(id), { ...draft, effectiveInput, status: "consumed" });
	}
	fail(id: string, failureCode: PromptFailureCode = "failed") {
		const draft = this.read(id);
		if (!draft || !["running", "preview"].includes(draft.status)) throw new Error("提示词提交状态不匹配");
		writeDurableJson(this.path(id), { ...draft, status: "failed", failureCode });
	}
}
export type PromptRewriter = (input: string, signal: AbortSignal) => Promise<PromptRewriteResult>;
export function createPromptRewriter(
	config: LightClawConfig,
	overrides: {
		model?: Model<Api>;
		apiKey?: string;
		onUsage?: (step: string, model: Model<Api>, usage: Usage | null) => void;
		target?: RewriteTarget;
	} = {},
): PromptRewriter {
	return async (input, signal) => {
		if (config.features?.optimization === false) throw new Error("提示词优化功能已关闭");
		if (!input.trim() || input.length > 12000) throw new Error("提示词须为1至12000字符");
		signal.throwIfAborted();
		const model = overrides.model ?? resolveModel(config);
		const apiKey =
			overrides.apiKey ??
			(await resolveApiKey(AuthStorage.create(join(homedir(), ".pi", "lightclaw", "auth.json")), model.provider));
		const target = overrides.target ?? DEFAULT_REWRITE_TARGET;
		const request = async (
			step: string,
			systemPrompt: string,
			payload: object,
			maxTokens: number,
		): Promise<string> => {
			let usage: Usage | null = null;
			try {
				const message = await completeSimple(
					model,
					{
						systemPrompt,
						messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }],
					},
					{ apiKey, signal, maxTokens, temperature: 0 },
				);
				if (message.usage.totalTokens > 0) usage = message.usage;
				signal.throwIfAborted();
				if (message.stopReason !== "stop") throw new Error(`提示词改写未完成：${message.stopReason}`);
				const text = message.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();
				if (!text) throw new Error(EMPTY_MODEL_RESPONSE_ERROR);
				return text;
			} finally {
				overrides.onUsage?.(step, model, usage);
			}
		};
		const result = parseRewrite(
			await request("rewrite", REWRITE_SYSTEM, { context: null, target, user_input: input }, 2048),
		);
		validateProtectedLiterals(input, result.prompt);
		await request("review", REVIEW_SYSTEM, { original: input, candidate: result, target }, 1024).then(validateReview);
		signal.throwIfAborted();
		return result;
	};
}
