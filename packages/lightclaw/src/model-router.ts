/**
 * 模型主备与降级。
 *
 * 只解决可用性：供应商限流、网关 5xx、连接失败时切到备用模型。
 * 不做智能路由（那需要在线评测闭环），也不在已产生输出后切换（会产生两个模型的拼接）。
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@mariozechner/pi-ai";

import { EMPTY_MODEL_RESPONSE_ERROR, hasActionableModelContent } from "./model-response.js";

export interface ModelRouterOptions {
	primary: Model<Api>;
	fallbacks: readonly Model<Api>[];
	/** 连续失败多少次后进入冷却。 */
	failureThreshold?: number;
	/** 冷却时长；期间使用第一个备用模型。 */
	cooldownMs?: number;
	now?: () => number;
}

const RETRYABLE_HINTS = [
	/\b429\b/,
	/\b5\d\d\b/,
	/timeout|timed out/i,
	/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i,
	/rate limit|overloaded|capacity/i,
];

export function isRetryableModelError(error: unknown): boolean {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return RETRYABLE_HINTS.some((pattern) => pattern.test(text));
}

export class ModelRouter {
	private readonly primary: Model<Api>;

	private readonly fallbacks: readonly Model<Api>[];

	private readonly failureThreshold: number;

	private readonly cooldownMs: number;

	private readonly now: () => number;

	private failures = 0;

	private openUntil = 0;

	constructor(options: ModelRouterOptions) {
		this.primary = options.primary;
		this.fallbacks = options.fallbacks;
		this.failureThreshold = options.failureThreshold ?? 1;
		this.cooldownMs = options.cooldownMs ?? 60_000;
		this.now = options.now ?? Date.now;
	}

	get hasFallback(): boolean {
		return this.fallbacks.length > 0;
	}

	get degraded(): boolean {
		return this.now() < this.openUntil;
	}

	/** 当前应使用的模型；冷却期内返回第一个备用。 */
	current(): Model<Api> {
		if (this.degraded && this.fallbacks.length > 0) return this.fallbacks[0];
		return this.primary;
	}

	/** 记录失败；达到阈值进入冷却。返回是否刚刚切换。 */
	recordError(error: unknown, model: Model<Api> = this.primary): boolean {
		if (model.provider !== this.primary.provider || model.id !== this.primary.id) return isRetryableModelError(error);
		if (!isRetryableModelError(error)) return false;
		this.failures += 1;
		if (this.failures < this.failureThreshold) return false;
		this.openUntil = this.now() + this.cooldownMs;
		return true;
	}

	recordSuccess(model: Model<Api> = this.primary): void {
		if (model.provider !== this.primary.provider || model.id !== this.primary.id) return;
		this.failures = 0;
		this.openUntil = 0;
	}

	/** 为当前失败选择一个备用模型；已在使用备用时不重复切换。 */
	fallbackFor(model: Model<Api>): Model<Api> | undefined {
		if (this.fallbacks.length === 0) return undefined;
		const index = this.fallbacks.findIndex(
			(candidate) => candidate.provider === model.provider && candidate.id === model.id,
		);
		if (index === -1) return this.fallbacks[0];
		return this.fallbacks[index + 1];
	}
}

export interface ModelAttempt {
	provider: string;
	model: string;
	attempt: number;
	status: "success" | "error" | "aborted";
	reason?: string;
	/** Null means provider did not report usage. Error-path all-zero placeholders are not evidence of zero usage. */
	usage: Usage | null;
	fallback: boolean;
}

function failureMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/** Each promise (including iterator.next) is interruptible even if a provider ignores its signal. */
async function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let onAbort = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, cancelled]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export function createRoutedStream(configuration: {
	router: ModelRouter;
	dispatch: StreamFn;
	getApiKey(provider: string): string | undefined | Promise<string | undefined>;
	onAttempt(attempt: ModelAttempt): void;
	timeoutMs?: number;
}): StreamFn {
	return (_requestModel, context, options) => {
		const outer = createAssistantMessageEventStream();
		const run = async () => {
			let model: Model<Api> | undefined = configuration.router.current();
			const visited = new Set<string>();
			let attempt = 0;
			while (model) {
				const selected: Model<Api> = model;
				visited.add(`${selected.provider}/${selected.id}`);
				attempt++;
				const controller = new AbortController();
				const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
				const timer = setTimeout(
					() => controller.abort(new Error("Model attempt timeout")),
					configuration.timeoutMs ?? 120_000,
				);
				let final: AssistantMessage | undefined;
				let output = false;
				let start: AssistantMessageEvent | undefined;
				try {
					signal.throwIfAborted();
					const apiKey = await interruptible(Promise.resolve(configuration.getApiKey(selected.provider)), signal);
					const stream = await interruptible(
						Promise.resolve(configuration.dispatch(selected, context, { ...options, apiKey, signal })),
						signal,
					);
					const iterator = stream[Symbol.asyncIterator]();
					while (true) {
						const next = await interruptible(iterator.next(), signal);
						if (next.done) break;
						const event = next.value;
						if (event.type === "start") {
							start = event;
							continue;
						}
						if (event.type === "error") {
							final = event.error;
							output ||= final.content.length > 0;
							break;
						}
						if (event.type === "done") {
							final = event.message;
							break;
						}
						// Any content event, including tool/thinking start, commits the attempt. Only an empty start is withheld.
						output = true;
						if (start) {
							outer.push(start);
							start = undefined;
						}
						outer.push(event);
					}
					if (!final) final = failureMessage(selected, "Provider stream ended without a terminal event", false);
				} catch (error) {
					final = failureMessage(selected, error, options?.signal?.aborted ?? false);
				} finally {
					clearTimeout(timer);
				}
				if (final.stopReason !== "error" && final.stopReason !== "aborted" && !hasActionableModelContent(final)) {
					final = { ...final, stopReason: "error", errorMessage: EMPTY_MODEL_RESPONSE_ERROR };
				}
				const success = final.stopReason !== "error" && final.stopReason !== "aborted";
				const reason = final.errorMessage;
				if (success) configuration.router.recordSuccess(selected);
				else if (final.stopReason !== "aborted") configuration.router.recordError(reason, selected);
				const candidate: Model<Api> | undefined =
					!success &&
					!output &&
					final.stopReason !== "aborted" &&
					!options?.signal?.aborted &&
					isRetryableModelError(reason)
						? configuration.router.fallbackFor(selected)
						: undefined;
				const fallback = candidate !== undefined && !visited.has(`${candidate.provider}/${candidate.id}`);
				const usage =
					success || final.usage.totalTokens > 0 || final.usage.cost.total > 0
						? structuredClone(final.usage)
						: null;
				configuration.onAttempt({
					provider: selected.provider,
					model: selected.id,
					attempt,
					status: success ? "success" : final.stopReason === "aborted" ? "aborted" : "error",
					reason,
					usage,
					fallback,
				});
				if (fallback) {
					model = candidate;
					continue;
				}
				if (start) outer.push(start);
				if (success)
					outer.push({ type: "done", reason: final.stopReason as "stop" | "length" | "toolUse", message: final });
				else
					outer.push({
						type: "error",
						reason: final.stopReason === "aborted" ? "aborted" : "error",
						error: final,
					});
				outer.end(final);
				return;
			}
		};
		// Audit/credential errors are terminal; obey the agent-core StreamFn protocol.
		void run().catch((error) => {
			const message = failureMessage(configuration.router.current(), error, options?.signal?.aborted ?? false);
			outer.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
			outer.end(message);
		});
		return outer;
	};
}
