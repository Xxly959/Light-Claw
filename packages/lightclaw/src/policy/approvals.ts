/**
 * 一次性审批票据。
 *
 * 设计要点：不在工具循环里阻塞等待人工输入。裁决为 approve 时落一张票据并阻止本次调用；
 * 创建者或管理员在聊天里批准后，签名相同的下一次调用被放行，票据立即转为 consumed。
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertExecutionAuthorized } from "../authorization.js";
import { writeDurableJson } from "../durable-state.js";
import { physicalPath } from "../goals/control.js";
import type { ChatActor } from "../transport.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed";

export interface ApprovalTicket {
	id: string;
	signature: string;
	channelId: string;
	toolName: string;
	summary: string;
	reason: string;
	capabilities: string[];
	/** 发起该操作的 run 所有者；即使频道状态被回收，也能据此判定谁有权批准。 */
	ownerUserId: string;
	taskCreatorUserId?: string;
	createdAt: string;
	expiresAt: string;
	status: ApprovalStatus;
	decidedBy?: string;
	decidedAt?: string;
	archiveId?: string;
}

export interface ApprovalMaintenance {
	archived: number;
	activeRecords: number;
	archiveId?: string;
}

interface ApprovalFile {
	schemaVersion: 1;
	tickets: ApprovalTicket[];
}

const MAX_TICKETS = 200;
const MAX_PENDING = 20;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** 票据签名：频道 + 工具 + 参数摘要，换一个参数就需要重新批准。 */
export function signatureFor(channelId: string, toolName: string, argsDigest: string): string {
	return createHash("sha256").update(`${channelId}\u0000${toolName}\u0000${argsDigest}`).digest("hex");
}

function assertTicket(value: unknown): asserts value is ApprovalTicket {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("审批票据必须是对象");
	const ticket = value as Record<string, unknown>;
	for (const field of [
		"id",
		"signature",
		"channelId",
		"toolName",
		"summary",
		"reason",
		"ownerUserId",
		"createdAt",
		"expiresAt",
	]) {
		if (typeof ticket[field] !== "string" || !(ticket[field] as string).trim())
			throw new Error(`审批票据缺少 ${field}`);
	}
	if (!Array.isArray(ticket.capabilities) || ticket.capabilities.some((item) => typeof item !== "string"))
		throw new Error("审批票据 capabilities 非法");
	if (!["pending", "approved", "denied", "consumed"].includes(String(ticket.status)))
		throw new Error("审批票据状态非法");
	for (const field of ["createdAt", "expiresAt"]) {
		if (!Number.isFinite(Date.parse(String(ticket[field])))) throw new Error(`审批票据 ${field} 非法`);
	}
	if (ticket.decidedBy !== undefined && typeof ticket.decidedBy !== "string")
		throw new Error("审批票据 decidedBy 非法");
	if (ticket.decidedAt !== undefined && typeof ticket.decidedAt !== "string")
		throw new Error("审批票据 decidedAt 非法");
}

export class ApprovalStore {
	private readonly path: string;

	private readonly channelId: string;

	private readonly ttlMs: number;

	constructor(
		private readonly options: {
			channelControlDir: string;
			channelId: string;
			ttlMs?: number;
			trustedUserIds?: readonly string[];
			adminUserIds?: readonly string[];
			onDecision?: (ticket: ApprovalTicket) => void;
			onMaintenance?: (phase: "intent" | "applied", actor: ChatActor, result: ApprovalMaintenance) => void;
		},
	) {
		this.channelId = options.channelId;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) throw new Error("审批 TTL 非法");
		this.path = join(physicalPath(options.channelControlDir), "approvals.json");
	}

	list(): ApprovalTicket[] {
		// 过期票据不在这里删除：让 /approve <id> 能给出"已过期"而不是"找不到票据"。
		const records = new Map<string, ApprovalTicket>();
		const archive = join(dirname(this.path), "approval-archives");
		if (existsSync(archive)) {
			if (physicalPath(archive) !== archive) throw new Error("审批归档目录被替换");
			for (const name of readdirSync(archive)
				.filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
				.sort()) {
				const tickets = this.read(join(archive, name));
				if (this.archiveId(tickets) !== name.slice(0, -5)) throw new Error("审批归档摘要不匹配");
				for (const ticket of tickets) records.set(ticket.id, { ...ticket, archiveId: name.slice(0, -5) });
			}
		}
		for (const ticket of this.read()) records.set(ticket.id, ticket);
		return [...records.values()];
	}

	private archiveId(tickets: ApprovalTicket[]): string {
		return createHash("sha256").update(JSON.stringify(tickets)).digest("hex");
	}
	maintain(actor: ChatActor): ApprovalMaintenance {
		return this.transaction(() => {
			const tickets = this.read();
			const owners = new Set(
				(tickets.length ? tickets : this.list()).map((t) => t.taskCreatorUserId ?? t.ownerUserId),
			);
			assertExecutionAuthorized(
				actor,
				owners.size === 1 ? [...owners][0] : undefined,
				this.options.trustedUserIds,
				this.options.adminUserIds,
			);
			const now = Date.now();
			const historical = tickets.filter(
				(t) => t.status === "denied" || t.status === "consumed" || Date.parse(t.expiresAt) <= now,
			);
			const ids = new Set(historical.map((t) => t.id));
			const active = tickets.filter((t) => !ids.has(t.id));
			const archiveId = historical.length ? this.archiveId(historical) : undefined;
			const result: ApprovalMaintenance = { archived: historical.length, activeRecords: active.length, archiveId };
			this.options.onMaintenance?.("intent", actor, result);
			if (historical.length) {
				const archive = join(dirname(this.path), "approval-archives");
				mkdirSync(archive, { recursive: true, mode: 0o700 });
				if (physicalPath(archive) !== archive) throw new Error("审批归档目录被替换");
				const path = join(archive, `${archiveId}.json`);
				if (existsSync(path)) {
					if (this.archiveId(this.read(path)) !== archiveId) throw new Error("审批归档冲突");
				} else writeDurableJson(path, { schemaVersion: 1, tickets: historical });
				this.write(active);
			}
			this.options.onMaintenance?.("applied", actor, result);
			return result;
		});
	}

	pending(): ApprovalTicket[] {
		const now = Date.now();
		return this.read().filter((ticket) => ticket.status === "pending" && Date.parse(ticket.expiresAt) > now);
	}

	create(input: {
		signature: string;
		toolName: string;
		summary: string;
		reason: string;
		capabilities: string[];
		ownerUserId: string;
		taskCreatorUserId?: string;
	}): ApprovalTicket {
		return this.transaction(() => {
			const now = Date.now();
			const tickets = this.read();
			const existing = tickets.find(
				(ticket) =>
					ticket.signature === input.signature &&
					["pending", "approved"].includes(ticket.status) &&
					Date.parse(ticket.expiresAt) > now,
			);
			if (existing) return existing;

			const pendingCount = tickets.filter(
				(ticket) => ticket.status === "pending" && Date.parse(ticket.expiresAt) > now,
			).length;
			if (pendingCount >= MAX_PENDING) throw new Error("待审批票据过多；先处理已有票据再重试");

			if (tickets.length >= MAX_TICKETS)
				throw new Error("审批活动历史已满；请由有权限人员执行 /approve maintain，不能静默删除取证记录");
			const ticket: ApprovalTicket = {
				id: randomBytes(16).toString("hex"),
				signature: input.signature,
				channelId: this.channelId,
				toolName: input.toolName,
				summary: input.summary,
				reason: input.reason,
				capabilities: [...input.capabilities],
				ownerUserId: input.ownerUserId,
				taskCreatorUserId: input.taskCreatorUserId,
				createdAt: new Date(now).toISOString(),
				expiresAt: new Date(now + this.ttlMs).toISOString(),
				status: "pending",
			};
			const next = [...tickets, ticket].slice(-MAX_TICKETS);
			this.write(next);
			return ticket;
		});
	}

	approve(id: string, userId: string): ApprovalTicket {
		return this.transaction(() => this.decide(id, userId, "approved"));
	}

	deny(id: string, userId: string): ApprovalTicket {
		return this.transaction(() => this.decide(id, userId, "denied"));
	}

	/** 找到已批准且签名匹配的票据，立即消费；同一票据不能放行第二次。 */
	consume(signature: string): ApprovalTicket | undefined {
		return this.transaction(() => {
			const tickets = this.read();
			const index = tickets.findIndex(
				(ticket) =>
					ticket.status === "approved" &&
					ticket.signature === signature &&
					Date.parse(ticket.expiresAt) > Date.now(),
			);
			if (index === -1) return undefined;
			const next = [...tickets];
			const ticket = { ...next[index], status: "consumed" as const };
			next[index] = ticket;
			this.write(next);
			return ticket;
		});
	}

	get(id: string): ApprovalTicket | undefined {
		return this.list().find((ticket) => ticket.id === id);
	}

	private decide(id: string, userId: string, status: "approved" | "denied"): ApprovalTicket {
		const tickets = this.read();
		const index = tickets.findIndex((ticket) => ticket.id === id);
		if (index === -1) {
			const history = this.get(id);
			if (history)
				throw new Error(
					`票据 ${id} 已归档（${Date.parse(history.expiresAt) <= Date.now() ? "已过期" : history.status}），不能再次处理`,
				);
			throw new Error(`找不到审批票据：${id}`);
		}
		const current = tickets[index];
		assertExecutionAuthorized(
			{ user: userId, origin: "platform" },
			current.taskCreatorUserId ?? current.ownerUserId,
			this.options.trustedUserIds,
			this.options.adminUserIds,
		);
		if (current.status !== "pending") throw new Error(`票据 ${id} 当前状态为 ${current.status}，不能再次处理`);
		if (Date.parse(current.expiresAt) <= Date.now()) throw new Error(`票据 ${id} 已过期，请让 Agent 重新发起`);

		const ticket: ApprovalTicket = {
			...current,
			status,
			decidedBy: userId,
			decidedAt: new Date().toISOString(),
		};
		this.options.onDecision?.(ticket);
		const next = [...tickets];
		next[index] = ticket;
		this.write(next);
		return ticket;
	}

	/** Synchronous RMW plus a filesystem mutex also excludes a second process. No stale-lock guessing. */
	private transaction<T>(operation: () => T): T {
		const directory = dirname(this.path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		if (physicalPath(directory) !== directory) throw new Error("审批控制目录已替换");
		const lock = join(directory, "approvals.lock");
		try {
			mkdirSync(lock, { mode: 0o700 });
		} catch {
			throw new Error("审批事务锁已占用；确认实例停止后检查残留锁");
		}
		try {
			return operation();
		} finally {
			rmdirSync(lock);
		}
	}

	private read(path = this.path): ApprovalTicket[] {
		if (physicalPath(dirname(path)) !== dirname(path)) throw new Error("审批父目录被替换");
		if (!existsSync(path)) return [];
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
			throw new Error(`审批票据文件必须是普通文件：${this.path}`);
		const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		let raw: string;
		try {
			const fdStat = fstatSync(handle);
			if (fdStat.nlink !== 1 || fdStat.size > MAX_FILE_BYTES) throw new Error("审批票据文件超出大小限制");
			raw = readFileSync(handle, "utf8");
		} finally {
			closeSync(handle);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`审批票据文件损坏：${this.path}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("审批票据文件结构非法");
		const file = parsed as Record<string, unknown>;
		if (file.schemaVersion !== 1) throw new Error("审批票据文件版本不支持");
		if (!Array.isArray(file.tickets)) throw new Error("审批票据列表非法");
		if (file.tickets.length > MAX_TICKETS) throw new Error("审批票据数量超出限制");
		for (const ticket of file.tickets) {
			assertTicket(ticket);
			if (ticket.channelId !== this.channelId) throw new Error("审批票据频道不匹配");
		}
		return file.tickets;
	}

	private write(tickets: ApprovalTicket[]): void {
		if (tickets.length > MAX_TICKETS) throw new Error("审批活动记录过多");
		const payload: ApprovalFile = { schemaVersion: 1, tickets };
		writeDurableJson(this.path, payload);
	}
}
