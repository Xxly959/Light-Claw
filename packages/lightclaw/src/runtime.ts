import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentRunner,
	type AgentRunnerOverrides,
	type AgentRunResult,
	getOrCreateRunner,
	releaseRunner,
} from "./agent.js";
import { CriticalAuditError, configureAuditDirectory } from "./audit/storage.js";
import { assertControlAuthorized, ControlAuthorizationError } from "./authorization.js";
import type { LightClawConfig } from "./config.js";
import { DurableInbox } from "./durable-inbox.js";
import { writeDurableJson } from "./durable-state.js";
import { createEventsWatcher } from "./events.js";
import { featureEnabled } from "./features.js";
import type { GoalCommandResult } from "./goals/commands.js";
import { handleGoalCommand } from "./goals/commands.js";
import {
	acquireControlLock,
	assertControlIsolation,
	resolveControlChannelDirectory,
	resolveControlDirectory,
} from "./goals/control.js";
import { GoalStore } from "./goals/store.js";
import { CacheCapacityError, IdleResourceCache } from "./idle-cache.js";
import * as log from "./log.js";
import { type RunAuditEvent, appendAuditEvent as writeAuditEvent } from "./observability.js";
import { OperationJournal } from "./operations.js";
import { fitPlatformText } from "./platform-text.js";
import { ApprovalStore } from "./policy/approvals.js";
import { handleApprovalCommand } from "./policy/commands.js";
import {
	createPromptRewriter,
	describePromptFailure,
	PromptDraftStore,
	PromptEntryStore,
	type PromptRewriter,
} from "./prompt-input.js";
import type { PromptRewriteResult } from "./prompt-rewrite.js";
import { handleRecoveryCommand } from "./recovery-control.js";
import { diagnosticText } from "./redaction.js";
import { assertNoUnconfirmedDockerTasks, type SandboxConfig } from "./sandbox.js";
import { ChannelStore } from "./store.js";
import { OperationTimeoutError, withTimeout } from "./timeouts.js";
import {
	type ChatContext,
	type ChatEvent,
	type ChatHandler,
	type ChatTransport,
	isImmediateGoalControl,
} from "./transport.js";

export interface RuntimeFault {
	kind: string;
	channelId: string;
	detail: string;
	timestamp: string;
}
export interface RuntimeOptions {
	promptRewriter?: PromptRewriter;
	onFault?: (fault: RuntimeFault) => void | Promise<void>;
	config: LightClawConfig;
	workingDir: string;
	sandbox: SandboxConfig;
	createTransport(handler: ChatHandler, inbox: DurableInbox): ChatTransport;
	createRunner?: (
		sandbox: SandboxConfig,
		channel: string,
		directory: string,
		config: LightClawConfig,
		goals: GoalStore,
		overrides?: AgentRunnerOverrides,
	) => AgentRunner;
	releaseRunner?: (directory: string) => void;
	onRun?: (event: ChatEvent, result: AgentRunResult) => void;
}

/**
 * 频道级沙箱解析：配置了专属容器就用它，否则按回退策略决定共享还是拒绝。
 * host 模式不参与该策略——它本身没有容器边界，拒绝会破坏本地开发。
 */
export function resolveChannelSandbox(channelId: string, base: SandboxConfig, config: LightClawConfig): SandboxConfig {
	// 基础设施特性关闭时统一走 host，频道容器映射不再生效，避免配置与特性开关互相矛盾。
	if (!featureEnabled(config, "infrastructure")) return base;
	const container = config.channelContainers?.[channelId];
	if (container) return { type: "docker", container };
	if (base.type === "docker" && config.sandboxFallback === "deny")
		throw new Error(`频道 ${channelId} 未配置专属容器，且 LIGHTCLAW_SANDBOX_FALLBACK=deny；拒绝使用共享容器`);
	return base;
}

/** Shared production orchestration; no configuration or credential loading on import. */
/** 决定本次 run 的输入文本：目标续跑 > 审批续跑 > 原始消息。 */
export function resolveRunText(event: ChatEvent, command: GoalCommandResult): string {
	if (command.goal) return command.goal.objective;
	if (command.retryText) return command.retryText;
	return event.text;
}

export async function createLightClawRuntime(options: RuntimeOptions) {
	const { config, workingDir, sandbox } = options;
	function appendAuditEvent(workspace: string, event: RunAuditEvent): void {
		if (featureEnabled(config, "infrastructure")) writeAuditEvent(workspace, event);
	}

	mkdirSync(workingDir, { recursive: true });
	const controlDir = resolveControlDirectory(workingDir, config.controlDir);
	await assertControlIsolation(workingDir, controlDir, sandbox);
	configureAuditDirectory(workingDir, controlDir);
	const controlLock = acquireControlLock(controlDir);
	const inbox = new DurableInbox(join(controlDir, ".inbox"));
	inbox.recover();
	inbox.dispatchPaused = true;
	const operations = new OperationJournal(join(controlDir, ".operations"));
	const promptEntries = new PromptEntryStore(join(controlDir, ".prompt-entry-cards"));
	const promptDrafts = new PromptDraftStore(join(controlDir, ".prompt-composer-v2"));
	const promptRuns = new Map<string, { controller: AbortController; user: string }>();

	let stopping = false;
	let runtimeReady = false;
	let healthTimer: ReturnType<typeof setInterval> | undefined;
	function reportFault(kind: string, channelId: string, detail: string): void {
		const fault: RuntimeFault = { kind, channelId, detail, timestamp: new Date().toISOString() };
		writeAuditEvent(workingDir, { type: "fault_raised", channelId, detail: JSON.stringify(fault) });
		if (options.onFault)
			void Promise.resolve()
				.then(() => options.onFault!(fault))
				.catch((error) => log.logWarning("Fault hook failed", diagnosticText(String(error))));
	}
	const inFlight = new Set<Promise<void>>();
	const platformRequests = new Set<Promise<unknown>>();
	function trackPlatformRequest<T>(operation: () => Promise<T>): Promise<T> {
		const request = Promise.resolve().then(operation);
		platformRequests.add(request);
		void request.then(
			() => platformRequests.delete(request),
			() => platformRequests.delete(request),
		);
		return request;
	}

	function goalStore(channelId: string): GoalStore {
		return new GoalStore({
			confirmationTtlMs: config.goalConfirmationTtlMs,
			enabled: featureEnabled(config, "goals"),
			acceptanceEnabled: featureEnabled(config, "acceptance"),
			controlsEnabled: featureEnabled(config, "controls"),
			channelDir: join(workingDir, channelId),
			controlChannelDir: resolveControlChannelDirectory(controlDir, channelId),
			limits: {
				maxCycles: config.maxGoalCycles,
				maxFailures: config.maxGoalFailures,
				maxStaleCycles: config.maxStaleCycles,
			},
		});
	}

	interface ChannelState {
		runOwnerUserId?: string;
		runGoalId?: string;
		running: boolean;
		inUse: number;
		runner: AgentRunner;
		store: ChannelStore;
		goals: GoalStore;
		approvals: ApprovalStore;
		stopRequested: boolean;
		stopMessageId?: string;
	}

	const channelStates = new IdleResourceCache<ChannelState>(
		{
			enabled: featureEnabled(config, "scheduling"),
			maxEntries: config.channelCacheMaxEntries ?? 128,
			idleTtlMs: config.channelCacheIdleTtlMs ?? 900_000,
		},
		(state) => state.running || state.inUse > 0,
		(_state, channelId) => (options.releaseRunner ?? releaseRunner)(join(workingDir, channelId)),
	);

	function createStore(): ChannelStore {
		return new ChannelStore({ workingDir, botToken: config.slack?.botToken });
	}

	function getState(channelId: string): ChannelState {
		return channelStates.getOrCreate(channelId, () => {
			const channelDir = join(workingDir, channelId);
			const goals = goalStore(channelId);
			goals.get();
			const approvals = new ApprovalStore({
				channelControlDir: resolveControlChannelDirectory(controlDir, channelId),
				channelId,
				ttlMs: config.approvalTtlMs,
				trustedUserIds: config.trustedUserIds,
				adminUserIds: config.controlAdminUserIds,
				onMaintenance: (phase, actor, result) =>
					writeAuditEvent(workingDir, {
						type: "approval_maintenance",
						channelId,
						detail: JSON.stringify({ phase, actor, result }),
					}),
				onDecision: (ticket) =>
					appendAuditEvent(workingDir, { type: "approval_decided", channelId, detail: JSON.stringify(ticket) }),
			});
			return {
				running: false,
				inUse: 0,
				store: createStore(),
				goals,
				approvals,
				runner: (options.createRunner ?? getOrCreateRunner)(
					resolveChannelSandbox(channelId, sandbox, config),
					channelId,
					channelDir,
					config,
					goals,
					{ approvals },
				),
				stopRequested: false,
			};
		});
	}

	function createChatContext(event: ChatEvent, transport: ChatTransport, isEvent?: boolean): ChatContext {
		let messageId: string | null = null;
		const threadMessageIds: string[] = [];
		let accumulatedText = "";
		let isWorking = true;
		let updatePromise = Promise.resolve();
		const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;
		const user = transport.getUser(event.user);
		let expired: OperationTimeoutError | undefined;
		const send = async <T>(operation: () => Promise<T>): Promise<T> => {
			if (expired) throw expired;
			try {
				return await withTimeout(
					() => trackPlatformRequest(operation),
					config.platformTimeoutMs ?? 30_000,
					"chat request",
				);
			} catch (error) {
				if (error instanceof OperationTimeoutError) expired = error;
				throw error;
			}
		};

		const serialize = (operation: () => Promise<void>): Promise<void> => {
			const next = () => {
				if (expired) throw expired;
				return operation();
			};
			updatePromise = updatePromise.then(next, next);
			return updatePromise;
		};
		const fit = (text: string): string => fitPlatformText(text, transport.kind);

		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: user?.userName,
				channel: event.channel,
				ts: event.ts,
				attachments: (event.attachments ?? []).map(({ local }) => ({ local })),
			},
			channelName: transport.getChannel(event.channel)?.name,
			channels: transport.getAllChannels(),
			users: transport.getAllUsers(),
			respond: (text, shouldLog = true) =>
				serialize(async () => {
					accumulatedText = fit(accumulatedText ? `${accumulatedText}\n${text}` : text);
					const displayText = isWorking ? `${accumulatedText} ...` : accumulatedText;
					if (messageId) await send(() => transport.updateMessage(event.channel, messageId!, displayText));
					else messageId = await send(() => transport.postMessage(event.channel, displayText));
					if (shouldLog) transport.logBotResponse(event.channel, text, messageId);
				}),
			replaceMessage: (text) =>
				serialize(async () => {
					accumulatedText = fit(text);
					const displayText = isWorking ? `${accumulatedText} ...` : accumulatedText;
					if (messageId) await send(() => transport.updateMessage(event.channel, messageId!, displayText));
					else messageId = await send(() => transport.postMessage(event.channel, displayText));
				}),
			respondInThread: (text) =>
				serialize(async () => {
					if (!messageId) return;
					threadMessageIds.push(await send(() => transport.postInThread(event.channel, messageId!, fit(text))));
				}),
			setTyping: (typing) =>
				serialize(async () => {
					if (!typing || messageId) return;
					accumulatedText = eventFilename ? `开始执行事件：${eventFilename}` : "正在思考";
					messageId = await send(() => transport.postMessage(event.channel, `${accumulatedText} ...`));
				}),
			uploadFile: (filePath, title) => send(() => transport.uploadFile(event.channel, filePath, title)),
			setWorking: (working) =>
				serialize(async () => {
					isWorking = working;
					if (messageId)
						await send(() =>
							transport.updateMessage(event.channel, messageId!, `${accumulatedText}${working ? " ..." : ""}`),
						);
				}),
			deleteMessage: () =>
				serialize(async () => {
					for (const id of threadMessageIds.reverse()) {
						try {
							await send(() => transport.deleteMessage(event.channel, id));
						} catch {}
					}
					if (messageId) await send(() => transport.deleteMessage(event.channel, messageId!));
					messageId = null;
				}),
		};
	}

	function continuationEvent(event: ChatEvent, cycle: number): ChatEvent {
		return {
			...event,
			origin: "continuation",
			ts: `goal-${Date.now()}-${cycle}`,
			text: "[LightClaw 自动续跑] 检查当前进展，继续推进长期目标。不要重复已经完成的工作。",
			attachments: [],
			files: undefined,
		};
	}

	async function deliver(channelId: string, phase: string, operation: () => Promise<unknown>): Promise<boolean> {
		try {
			await withTimeout(() => trackPlatformRequest(operation), config.platformTimeoutMs ?? 30_000, phase);
			return true;
		} catch (error) {
			const detail = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
			log.logWarning(`[${channelId}] Delivery error`, detail);
			reportFault("delivery_failed", channelId, detail);
			appendAuditEvent(workingDir, { type: "delivery_failed", channelId, detail });
			return false;
		}
	}

	function pauseActive(state: ChannelState, channelId: string, reason: string): void {
		if (state.goals.get()?.status !== "active") return;
		const goal = state.goals.pause(reason);
		appendAuditEvent(workingDir, {
			type: "goal_state_changed",
			channelId,
			goalId: goal.id,
			cycle: goal.cycle,
			detail: reason,
		});
	}

	const executionHandler: ChatHandler = {
		isRunning: (channelId) => promptRuns.has(channelId) || (channelStates.peek(channelId)?.running ?? false),

		async handleQueueFailure(event, transport, reason) {
			reportFault(`queue_${reason}`, event.channel, "Durable queue admission/expiry requires operator attention");
			const detail =
				reason === "full"
					? "频道待处理队列已满，任务未接纳，请稍后重试。"
					: "任务排队等待超时，尚未执行，请重新发送。";
			appendAuditEvent(workingDir, {
				type: `queue_${reason}`,
				channelId: event.channel,
				detail,
				messageId: event.ts,
			});
			const state = channelStates.peek(event.channel);
			if (!state?.running && (reason === "expired" || event.ts.startsWith("goal-recovery-"))) {
				const goals = state?.goals ?? goalStore(event.channel);
				if (goals.get()?.status === "active") goals.pause(`${detail} 检查后发送 /goal resume。`);
			}
			await deliver(event.channel, "queue-notice", () => transport.postMessage(event.channel, detail));
		},

		async handleStop(channelId, transport, actor) {
			const optimization = promptRuns.get(channelId);
			if (optimization) {
				try {
					assertControlAuthorized(actor, optimization.user, config.controlAdminUserIds);
				} catch {
					await deliver(channelId, "prompt-stop-denied", () =>
						transport.postMessage(channelId, "无权限停止提示词优化"),
					);
					return;
				}
				optimization.controller.abort();
				await deliver(channelId, "prompt-stop", () => transport.postMessage(channelId, "正在停止提示词优化"));
				return;
			}
			const state = channelStates.peek(channelId);
			if (!state?.running) {
				await deliver(channelId, "idle-stop", () => transport.postMessage(channelId, "当前没有正在执行的任务"));
				return;
			}
			try {
				assertControlAuthorized(actor, state.runOwnerUserId, config.controlAdminUserIds);
			} catch (error) {
				await deliver(channelId, "stop-denied", () =>
					transport.postMessage(
						channelId,
						error instanceof ControlAuthorizationError
							? error.message
							: diagnosticText(error instanceof Error ? error.message : String(error)),
					),
				);
				return;
			}
			state.stopRequested = true;
			state.runner.abort();
			if (state.goals.get()?.status === "active") state.goals.pause("用户停止");
			await deliver(channelId, "stop", async () => {
				state.stopMessageId = await withTimeout(
					() => transport.postMessage(channelId, "正在停止..."),
					config.platformTimeoutMs ?? 30_000,
					"stop notification",
				);
			});
		},

		async handleEvent(event, transport, isEvent) {
			const recovery = handleRecoveryCommand(event.text, {
				inbox,
				operations,
				event,
				adminUserIds: config.controlAdminUserIds,
				trustedUserIds: config.trustedUserIds,
				assertExclusive: () => {
					const state = channelStates.peek(event.channel);
					if (stopping || state?.running || (state?.inUse ?? 0) > 0)
						throw new Error("频道或实例正在执行，不能并发人工处置");
				},
				audit: (entry) =>
					writeAuditEvent(workingDir, {
						type: "recovery_decided",
						channelId: event.channel,
						detail: JSON.stringify(entry),
					}),
			});
			if (recovery) {
				if (recovery.operationRetry) {
					const record = recovery.operationRetry;
					const receipt = await operations.execute(
						record.scope,
						record.key,
						record.request,
						{
							replaySafe: false,
							query: async () => ({ status: "unknown" }),
							execute: async () => ({
								messageId: await trackPlatformRequest(() =>
									transport.postMessage(
										event.channel,
										`人工授权补发结果通知（可能重复）：${JSON.stringify(record.request)}；完整结果请核对频道已保存的交付物。`,
									),
								),
							}),
						},
						record.ownerUserId,
					);
					writeAuditEvent(workingDir, {
						type: "recovery_decided",
						channelId: event.channel,
						detail: `operation_retry ${record.id}: ${receipt.status}`,
					});
				}
				await deliver(event.channel, "recovery", () => transport.postMessage(event.channel, recovery.response));
				if (!inbox.unresolvedChannels().has(event.channel)) {
					for (const record of inbox
						.list()
						.filter((r) => r.event.channel === event.channel && r.status === "queued"))
						transport.enqueueAccepted?.(record.event, record.isEvent);
				}
				return;
			}
			if (
				inbox.unresolvedChannels().has(event.channel) &&
				!isImmediateGoalControl(event) &&
				!/^\/(?:goal\s+(?:status|confirm|reject)|approve)\b/.test(event.text.trim())
			) {
				throw new Error("频道有执行结果未知的任务；先检查副作用并人工处理 inbox 记录，再重试");
			}

			if (
				transport.kind === "feishu" &&
				/^(?:任务入口|\/prompt-entry)$/.test(event.text.trim()) &&
				!event.promptSubmission &&
				!event.promptConfirmation &&
				!event.promptEntry
			) {
				try {
					if (
						event.origin !== "platform" ||
						!event.user ||
						!featureEnabled(config, "optimization") ||
						!transport.postPromptEntryCard
					)
						throw new Error("当前入口不支持任务卡片");
					const entry = promptEntries.create(event);
					writeAuditEvent(workingDir, {
						type: "prompt_optimization",
						channelId: event.channel,
						detail: JSON.stringify({ phase: "entry_requested", id: entry.id, actor: event.user }),
					});
					if (!entry.messageId)
						await deliver(event.channel, "prompt-entry", async () => {
							const messageId = await transport.postPromptEntryCard!(event.channel, entry.id);
							promptEntries.bind(entry.id, messageId);
						});
				} catch (error) {
					if (error instanceof CriticalAuditError) throw error;
					await deliver(event.channel, "prompt-entry-error", () =>
						transport.postMessage(event.channel, describePromptFailure(error).message),
					);
				}
				return;
			}

			if (
				transport.kind === "feishu" &&
				(event.promptEntry || /^\/prompt(?:\s|$)/.test(event.text.trim())) &&
				!event.promptSubmission &&
				!event.promptConfirmation
			) {
				try {
					if (
						event.origin !== "platform" ||
						transport.kind !== "feishu" ||
						!featureEnabled(config, "optimization") ||
						!transport.postPromptComposerCard
					)
						throw new Error("当前入口不支持提示词表单");
					if (event.promptEntry) {
						promptEntries.assertBound(event.promptEntry.id, event.channel, event.promptEntry.messageId);
						writeAuditEvent(workingDir, {
							type: "prompt_optimization",
							channelId: event.channel,
							detail: JSON.stringify({ phase: "entry_opened", id: event.promptEntry.id, actor: event.user }),
						});
					}
					const initialInput = event.promptEntry ? "" : event.text.trim().slice("/prompt".length).trimStart();
					const draft = promptDrafts.create({ ...event, text: initialInput });
					if (!draft.messageId) {
						const sent = await deliver(event.channel, "prompt-form", async () => {
							const messageId = await transport.postPromptComposerCard!(event.channel, draft.id, initialInput);
							promptDrafts.bindCard(draft.id, messageId);
						});
						if (!sent) return;
					}
				} catch (error) {
					if (error instanceof CriticalAuditError) throw error;
					await deliver(event.channel, "prompt-form-error", () =>
						transport.postMessage(event.channel, describePromptFailure(error).message),
					);
				}
				return;
			}
			const fromPromptForm = event.promptSubmission !== undefined || event.promptConfirmation !== undefined;
			const promptAction = event.promptSubmission ?? event.promptConfirmation;
			if (promptAction) {
				const action = promptAction;
				const confirming = event.promptConfirmation !== undefined;
				let claimed = false,
					consumed = false;
				const controller = new AbortController();
				let deadline: ReturnType<typeof setTimeout> | undefined;
				let rewriteTimedOut = false;
				try {
					if (
						event.origin !== "platform" ||
						transport.kind !== "feishu" ||
						!featureEnabled(config, "optimization")
					)
						throw new Error("提示词表单不可用");
					if (channelStates.peek(event.channel)?.running || promptRuns.has(event.channel))
						throw new Error("频道正在运行，请结束后重新打开 /prompt");
					if (goalStore(event.channel).get()?.status === "active")
						throw new Error("请先暂停当前长期目标，再提交独立提示词");
					if (!confirming && event.promptSubmission?.optimize && !transport.showPromptPreviewCard)
						throw new Error("当前入口不支持提示词表单");
					const draft = confirming
						? promptDrafts.confirm(action.draftId, event.user, event.channel, action.messageId, action.input)
						: promptDrafts.claim(
								action.draftId,
								event.user,
								event.channel,
								action.messageId,
								action.input,
								event.promptSubmission!.optimize,
							);
					claimed = true;
					writeAuditEvent(workingDir, {
						type: "prompt_optimization",
						channelId: event.channel,
						detail: JSON.stringify({
							phase: confirming ? "confirmed" : "submitted",
							id: draft.id,
							actor: event.user,
							optimize: draft.optimize,
						}),
					});
					promptRuns.set(event.channel, { controller, user: event.user });
					if (transport.closePromptComposerCard)
						await deliver(event.channel, "prompt-form-close", () =>
							transport.closePromptComposerCard!(event.channel, action.messageId, "submitted"),
						);
					controller.signal.throwIfAborted();
					let effectiveInput = confirming ? action.input : draft.input;
					let rewriteDetails: PromptRewriteResult | undefined;
					if (draft.optimize && !confirming) {
						const timeoutMs = config.modelAttemptTimeoutMs ?? 120000;
						deadline = setTimeout(() => {
							rewriteTimedOut = true;
							controller.abort();
						}, timeoutMs);
						const rewrite =
							options.promptRewriter ??
							createPromptRewriter(config, {
								onUsage: (step, model, usage) =>
									writeAuditEvent(workingDir, {
										type: "prompt_optimization",
										channelId: event.channel,
										detail: JSON.stringify({
											id: draft.id,
											step,
											provider: model.provider,
											model: model.id,
											usage,
										}),
									}),
							});
						rewriteDetails = await withTimeout(
							() => rewrite(draft.input, controller.signal),
							timeoutMs,
							"prompt rewrite",
						);
						effectiveInput = rewriteDetails.prompt;
						controller.signal.throwIfAborted();
					}
					if (stopping) throw new Error("停止期间不执行提示词");
					if (draft.optimize && !confirming) {
						promptDrafts.preview(draft.id, effectiveInput, rewriteDetails);
						const shown = await deliver(event.channel, "prompt-preview", () =>
							transport.showPromptPreviewCard!(
								event.channel,
								action.messageId,
								draft.id,
								effectiveInput,
								draft.input,
								rewriteDetails,
							),
						);
						if (!shown) throw new Error("提示词预览未确认送达");
						controller.signal.throwIfAborted();
						writeAuditEvent(workingDir, {
							type: "prompt_optimization",
							channelId: event.channel,
							detail: JSON.stringify({ phase: "preview", id: draft.id, effectiveChars: effectiveInput.length }),
						});
						return; // Preview is UI/control state, never an Agent turn.
					}
					promptDrafts.consume(draft.id, effectiveInput);
					consumed = true;
					writeAuditEvent(workingDir, {
						type: "prompt_optimization",
						channelId: event.channel,
						detail: JSON.stringify({
							phase: "consumed",
							id: draft.id,
							optimize: draft.optimize,
							originalChars: draft.input.length,
							effectiveChars: effectiveInput.length,
						}),
					});
					event = { ...event, text: effectiveInput, promptSubmission: undefined, promptConfirmation: undefined };
				} catch (error) {
					if (error instanceof CriticalAuditError) throw error;
					const failure = describePromptFailure(error, {
						timedOut: rewriteTimedOut,
						cancelled: controller.signal.aborted,
					});
					if (claimed && !consumed) promptDrafts.fail(action.draftId, failure.code);
					writeAuditEvent(workingDir, {
						type: "prompt_optimization",
						channelId: event.channel,
						detail: JSON.stringify({ phase: "failed", id: action.draftId, failureCode: failure.code }),
					});
					if (claimed && transport.closePromptComposerCard)
						await deliver(event.channel, "prompt-form-failed", () =>
							transport.closePromptComposerCard!(event.channel, action.messageId, "failed", failure.message),
						);
					await deliver(event.channel, "prompt-submission-failed", () =>
						transport.postMessage(
							event.channel,
							`提示词未执行：${failure.message} 请点击任务入口的“输入任务”重新打开表单。`,
						),
					);
					return;
				} finally {
					controller.abort();
					clearTimeout(deadline);
					if (promptRuns.get(event.channel)?.controller === controller) promptRuns.delete(event.channel);
				}
			}

			let state: ChannelState;
			let command: GoalCommandResult;
			try {
				state = getState(event.channel);
				state.inUse++;
				try {
					// 审批命令必须绕过目标命令解析：它只处理票据，不启动 run。
					const approval: ReturnType<typeof handleApprovalCommand> = fromPromptForm
						? { handled: false }
						: handleApprovalCommand(event.text, {
								assertMaintenance: () => {
									if (stopping || state.running || state.inUse > 1 || promptRuns.has(event.channel))
										throw new Error("频道正在执行，不能并发审批维护");
								},
								approvals: state.approvals,
								userId: event.user,
								origin: event.origin,
								ownerUserId: state.runOwnerUserId,
								trustedUserIds: config.trustedUserIds,
								adminUserIds: config.controlAdminUserIds,
							});
					if (approval.handled) {
						// 批准即续跑；但当前频道已有任务时不并发启动，避免 runner 重入。
						const canResume = approval.startRun === true && !state.running;
						const suffix =
							approval.startRun && state.running
								? "\n当前有任务在运行，批准已生效；等它结束后重新执行同一操作即可。"
								: "";
						if (approval.response)
							await deliver(event.channel, "approval", () =>
								transport.postMessage(event.channel, `${approval.response}${suffix}`),
							);
						if (!canResume) return;
						command = {
							handled: true,
							startRun: true,
							retryText: approval.retryText,
							executionUserId: approval.executionUserId,
						};
					} else {
						command = fromPromptForm
							? { handled: false, startRun: false, executionUserId: event.user }
							: featureEnabled(config, "goals")
								? await handleGoalCommand(event.text, state.goals, {
										userId: event.user,
										adminUserIds: config.controlAdminUserIds,
										origin: event.origin,
										sandbox,
										signal: featureEnabled(config, "controls")
											? AbortSignal.timeout(config.maxRunDurationMs ?? 300_000)
											: new AbortController().signal,
									})
								: { handled: false, startRun: false };
						// The command must pass authorization and state validation before cancellation.
						// A historical goal does not grant control of an unrelated ordinary run.
						if (
							state.running &&
							isImmediateGoalControl(event) &&
							command.goal?.id === state.runGoalId &&
							state.runGoalId
						) {
							assertControlAuthorized(event, state.runOwnerUserId, config.controlAdminUserIds);
							state.stopRequested = true;
							state.runner.abort();
						}
					}
				} finally {
					state.inUse--;
				}
			} catch (error) {
				if (error instanceof CriticalAuditError) throw error;
				if (error instanceof CacheCapacityError) {
					await handler.handleQueueFailure(event, transport, "full");
					return;
				}
				await deliver(event.channel, "command-error", () =>
					transport.postMessage(
						event.channel,
						`目标命令失败：${error instanceof ControlAuthorizationError ? error.message : diagnosticText(error instanceof Error ? error.message : String(error))}`,
					),
				);
				return;
			}
			if (stopping) throw new Error("Shutdown before command execution");
			state.inUse++;
			try {
				if (command.handled) {
					if (command.goal) {
						appendAuditEvent(workingDir, {
							type:
								command.goal.completion?.method === "human"
									? "goal_confirmed"
									: command.startRun && command.goal.cycle === 0
										? "goal_created"
										: "goal_state_changed",
							channelId: event.channel,
							goalId: command.goal.id,
							cycle: command.goal.cycle,
							detail: command.goal.status,
							attemptId: command.goal.completion?.attemptId,
							completionMethod: command.goal.completion?.method,
						});
					}
					if (
						command.response &&
						!(await deliver(event.channel, "command", () =>
							transport.postMessage(event.channel, command.response!),
						))
					) {
						if (command.startRun && !stopping)
							pauseActive(state, event.channel, "目标确认消息投递失败，发送 /goal resume 重试");
						return;
					}

					if (!command.startRun) return;
				}

				if (stopping) throw new Error("Shutdown before runner start");
				state.running = true;
				state.runGoalId = state.goals.get()?.status === "active" ? state.goals.get()?.id : undefined;
				state.runOwnerUserId =
					command.executionUserId ??
					command.goal?.ownerUserId ??
					(state.goals.get()?.status === "active"
						? state.goals.get()?.ownerUserId
						: event.origin === "platform"
							? event.user
							: undefined);
				state.stopRequested = false;
				let currentEvent = {
					...event,
					user:
						command.executionUserId ??
						command.goal?.ownerUserId ??
						(event.origin === "recovery" && state.goals.get()?.status === "active"
							? state.goals.get()?.ownerUserId
							: undefined) ??
						event.user,
					text: resolveRunText(event, command),
				};
				try {
					while (!state.stopRequested) {
						const before = state.goals.get();
						const ctx = createChatContext(currentEvent, transport, isEvent);
						if (!(await deliver(event.channel, "typing", () => ctx.setTyping(true)))) {
							pauseActive(state, event.channel, "平台投递失败，发送 /goal resume 重试");
							break;
						}
						if (state.stopRequested || stopping) break;
						const startedAt = Date.now();
						let result: Awaited<ReturnType<AgentRunner["run"]>>;
						try {
							result = await state.runner.run(ctx, state.store);
							options.onRun?.(currentEvent, result);
							if (stopping) break;
						} catch (error) {
							if (error instanceof CriticalAuditError) throw error;
							if (stopping) break;
							const detail = error instanceof Error ? error.message : String(error);
							appendAuditEvent(workingDir, {
								type: "run_finished",
								channelId: event.channel,
								goalId: before?.id,
								cycle: before ? before.cycle + 1 : undefined,
								durationMs: Date.now() - startedAt,
								stopReason: "error",
								detail,
							});
							if (state.goals.get()?.status === "active") state.goals.recordCycle(true, false);
							pauseActive(state, event.channel, "执行异常已暂停，检查副作用后发送 /goal resume 重试");
							await deliver(event.channel, "execution-error", () =>
								transport.postMessage(event.channel, `执行失败：${diagnosticText(detail)}`),
							);
							break;
						}

						appendAuditEvent(workingDir, {
							type: "run_finished",
							channelId: event.channel,
							goalId: before?.id,
							cycle: before ? before.cycle + 1 : undefined,
							durationMs: result.durationMs,
							stopReason: result.stopReason,
							toolCalls: result.toolCalls,
							verificationCommandCount: result.verificationCommandCount,
							toolErrors: result.toolErrors,
							inputTokens: result.usageIncomplete ? undefined : result.inputTokens,
							outputTokens: result.usageIncomplete ? undefined : result.outputTokens,
							cost: result.usageIncomplete ? undefined : result.cost,
							usageIncomplete: result.usageIncomplete,
							detail: result.budgetReason,
						});

						const after = state.goals.get();
						for (const report of after?.verificationHistory ?? []) {
							if (before?.verificationHistory.some((item) => item.attemptId === report.attemptId)) continue;
							appendAuditEvent(workingDir, {
								type: "verification_finished",
								channelId: event.channel,
								goalId: after?.id,
								attemptId: report.attemptId,
								verificationStatus: report.status,
								completionMethod: after?.completion?.method,
								verificationCommandCount: result.verificationCommandCount,
								detail: report.checks.map((check) => check.reasonCode).join(","),
							});
						}
						if (before && after?.status !== before.status) {
							appendAuditEvent(workingDir, {
								type: "goal_state_changed",
								channelId: event.channel,
								goalId: after?.id,
								cycle: after?.cycle,
								detail: after?.status,
							});
						}
						const failed =
							result.stopReason === "error" || (result.stopReason === "aborted" && !result.deliveryError);
						const recorded =
							after?.status === "active"
								? state.goals.recordCycle(failed, after.progressVersion > (before?.progressVersion ?? 0))
								: after;
						if (result.budgetReason) pauseActive(state, event.channel, result.budgetReason);
						if (result.deliveryError) {
							appendAuditEvent(workingDir, {
								type: "delivery_failed",
								channelId: event.channel,
								detail: result.deliveryError,
							});
							pauseActive(
								state,
								event.channel,
								`平台投递失败；检查结果后发送 /goal resume：${result.deliveryError}`,
							);
							break;
						}
						const notification = await operations.execute(
							`notification:${event.channel}:${event.origin}:${event.ts}`,
							`final:${after?.id ?? "ordinary"}:${after?.revision ?? 0}:${after?.cycle ?? 0}`,
							{ goalId: after?.id ?? null, status: after?.status ?? "ordinary", cycle: after?.cycle ?? null },
							{
								replaySafe: false,
								query: async () => ({ status: "unknown" }),
								execute: async () => {
									if (!(await deliver(event.channel, "final-update", () => ctx.setWorking(false))))
										throw new Error("Final notification outcome unknown");
									return { delivered: true };
								},
							},
							state.runOwnerUserId,
						);
						if (notification.status !== "succeeded") {
							pauseActive(state, event.channel, "结果已保存但平台投递失败，发送 /goal resume 重试");
							await deliver(event.channel, "delivery-notice", () =>
								transport.postMessage(
									event.channel,
									after?.status === "completed"
										? "目标已完成，结果已保存；最终消息投递失败"
										: "本轮执行结果已保存；最终消息投递失败",
								),
							);
							break;
						}
						if (!recorded || after?.status !== "active" || result.budgetReason) break;
						if (recorded.status !== "active") {
							appendAuditEvent(workingDir, {
								type: "goal_state_changed",
								channelId: event.channel,
								goalId: recorded.id,
								cycle: recorded.cycle,
								detail: recorded.pauseReason,
							});
							await deliver(event.channel, "paused", () =>
								transport.postMessage(event.channel, `长期目标已暂停：${recorded.pauseReason}`),
							);
							break;
						}
						currentEvent = continuationEvent(currentEvent, recorded.cycle);
						isEvent = true;
					}

					if (state.stopMessageId) {
						await deliver(event.channel, "stopped", () =>
							transport.updateMessage(event.channel, state.stopMessageId!, "已停止"),
						);
						state.stopMessageId = undefined;
					}
				} catch (error) {
					if (error instanceof CriticalAuditError) {
						if (state.goals.get()?.status === "active") state.goals.pause("关键审计失败，需核对恢复记录");
						throw error;
					}
					log.logWarning(`[${event.channel}] Run error`, error instanceof Error ? error.message : String(error));
					const goal = state.goals.get();
					if (goal?.status === "active")
						pauseActive(state, event.channel, "入口异常已暂停，检查后发送 /goal resume 重试");
					await deliver(event.channel, "entry-error", () =>
						transport.postMessage(
							event.channel,
							`执行失败：${diagnosticText(error instanceof Error ? error.message : String(error))}`,
						),
					);
				} finally {
					state.running = false;
					state.runOwnerUserId = undefined;
					state.runGoalId = undefined;
				}
			} finally {
				state.inUse--;
			}
		},
	};

	const handler: ChatHandler = {
		...executionHandler,
		handleEvent(event, transport, isEvent) {
			if (stopping) return Promise.reject(new Error("Instance is stopping; work retained for recovery"));
			const work = executionHandler.handleEvent(event, transport, isEvent).then(() => {
				if (stopping) throw new Error("Shutdown interrupted work; inspect saved state before retry");
			});
			inFlight.add(work);
			void work.then(
				() => inFlight.delete(work),
				() => inFlight.delete(work),
			);
			return work;
		},
	};

	const transport = options.createTransport(handler, inbox);
	const eventsWatcher = createEventsWatcher(workingDir, transport, {
		misfireMaxLatenessMs: config.scheduleMisfireMaxLatenessMs,
		onFault: (fault) => reportFault(fault.kind, "system", JSON.stringify(fault)),
	});
	const writeHealth = () =>
		writeDurableJson(join(controlDir, "health.json"), {
			schema: 1,
			pid: process.pid,
			heartbeatAt: Date.now(),
			ready: runtimeReady,
			platform: transport.connectionStatus?.() ?? "unverified",
		});
	writeHealth();
	let shutdownPromise: Promise<void> | undefined;
	function shutdown(): Promise<void> {
		if (shutdownPromise) return shutdownPromise;
		stopping = true;
		runtimeReady = false;
		clearInterval(healthTimer);
		try {
			writeHealth();
		} catch (error) {
			log.logWarning("Shutdown health write failed; continuing cancellation/drain", diagnosticText(String(error)));
		}
		inbox.stopAdmission();
		for (const run of promptRuns.values()) run.controller.abort();
		eventsWatcher.stop();
		for (const state of channelStates.values()) {
			state.stopRequested = true;
			state.runner.abort();
			// Keep active goals recoverable on process restart; user pause/cancel remains distinct.
		}
		shutdownPromise = (async () => {
			await transport.stop?.();
			await Promise.allSettled([...inFlight]);
			// A wrapper timeout does not prove the native platform request has settled.
			while (platformRequests.size) await Promise.allSettled([...platformRequests]);
			channelStates.close();
			assertNoUnconfirmedDockerTasks();
			controlLock.release();
		})();
		return shutdownPromise;
	}

	async function start(): Promise<void> {
		try {
			await transport.start();
			if (stopping) throw new Error("Startup interrupted by shutdown");
			runtimeReady = true;
			writeHealth();
			let lastConnection = transport.connectionStatus?.();
			healthTimer = setInterval(() => {
				try {
					writeHealth();
					const current = transport.connectionStatus?.();
					if (current && current !== lastConnection && ["disconnected", "reconnecting"].includes(current))
						reportFault("platform_connection", "system", current);
					lastConnection = current;
				} catch (error) {
					log.logWarning("Health heartbeat failed; readiness will become stale", diagnosticText(String(error)));
				}
			}, 10000);
			healthTimer.unref();
			inbox.dispatchPaused = false;
			// Replay only persisted queued requests. Interrupted executions become unknown/manual.
			const recovered = inbox.list().filter((record) => record.status === "queued");
			const unresolvedChannels = inbox.unresolvedChannels();
			for (const record of recovered) {
				if (unresolvedChannels.has(record.event.channel)) continue;
				if (transport.enqueueAccepted) transport.enqueueAccepted(record.event, record.isEvent);
				else transport.enqueueEvent(record.event);
			}
			eventsWatcher.start();
			const blockedChannels = new Set(
				inbox
					.list()
					.filter((r) => ["queued", "running", "unknown"].includes(r.status))
					.map((r) => r.event.channel),
			);
			const recoveryChannels = new Set(
				(featureEnabled(config, "goals")
					? [
							...readdirSync(controlDir, { withFileTypes: true }),
							...readdirSync(workingDir, { withFileTypes: true }),
						]
					: []
				)
					.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
					.map((entry) => entry.name),
			);
			for (const channelId of recoveryChannels) {
				const channelDir = join(workingDir, channelId);
				if (!existsSync(join(channelDir, "goal.json")) && !existsSync(join(controlDir, channelId, "goal.json")))
					continue;
				try {
					const goal = goalStore(channelId).get();
					if (goal?.status !== "active") continue;
					if (blockedChannels.has(channelId)) continue;
					transport.enqueueEvent({
						type: "dm",
						origin: "recovery",
						channel: channelId,
						ts: `goal-recovery-${goal.id}-${goal.cycle}`,
						user: "lightclaw",
						text: "[LightClaw 崩溃恢复] 读取已保存进展，检查已发生副作用后继续推进长期目标。",
					});
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					log.logWarning(`[${channelId}] Goal recovery skipped`, detail);
					appendAuditEvent(workingDir, { type: "goal_state_invalid", channelId, detail });
				}
			}
		} catch (error) {
			await shutdown();
			throw error;
		}
	}

	return {
		handler,
		transport,
		inbox,
		goalStore,
		start,
		shutdown,
		async compact(channelId: string): Promise<void> {
			const runner = getState(channelId).runner;
			if (!runner.compact) throw new Error("Runner does not support compaction");
			await runner.compact();
		},
		async idle(): Promise<void> {
			await transport.drain?.();
			while (inFlight.size) await Promise.allSettled([...inFlight]);
		},
	};
}
