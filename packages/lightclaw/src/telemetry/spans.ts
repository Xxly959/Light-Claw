/**
 * 链路追踪导出。
 *
 * 不引入 OpenTelemetry SDK：产出的记录与 OTLP/JSON 字段一致（traceId/spanId/parentSpanId/纳秒时间戳），
 * 既能被本地 grep，也能直接 POST 给 collector。层级为 run -> tool_call。
 */

import { randomBytes } from "node:crypto";
import { appendManagedAudit } from "../audit/storage.js";

export interface SpanRecord {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: "INTERNAL";
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: Record<string, string | number | boolean>;
	status: { code: "OK" | "ERROR"; message?: string };
}

export interface ActiveSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startNs: bigint;
	attributes: Record<string, string | number | boolean>;
}

function newId(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

function nowNs(): bigint {
	return BigInt(Date.now()) * 1_000_000n;
}

export class SpanRecorder {
	private readonly workspaceDir: string;

	private readonly endpoint: string | undefined;

	private readonly collected: SpanRecord[] = [];

	constructor(options: { workspaceDir: string; endpoint?: string }) {
		this.workspaceDir = options.workspaceDir;
		this.endpoint = options.endpoint?.trim() || undefined;
	}

	begin(
		name: string,
		options?: {
			parent?: ActiveSpan;
			traceId?: string;
			attributes?: Record<string, string | number | boolean>;
		},
	): ActiveSpan {
		return {
			traceId: options?.parent?.traceId ?? options?.traceId ?? newId(16),
			spanId: newId(8),
			parentSpanId: options?.parent?.spanId,
			name,
			startNs: nowNs(),
			attributes: { ...options?.attributes },
		};
	}

	end(span: ActiveSpan, status: { code: "OK" | "ERROR"; message?: string }, attributes = {}): void {
		const record: SpanRecord = {
			traceId: span.traceId,
			spanId: span.spanId,
			name: span.name,
			kind: "INTERNAL",
			startTimeUnixNano: span.startNs.toString(),
			endTimeUnixNano: nowNs().toString(),
			attributes: { ...span.attributes, ...attributes },
			status,
		};
		if (span.parentSpanId) record.parentSpanId = span.parentSpanId;
		this.collected.push(record);
	}

	/** 写本地 JSONL；配置 endpoint 时异步推送，推送失败不影响运行。 */
	flush(): void {
		if (this.collected.length === 0) return;
		for (const record of this.collected)
			appendManagedAudit(this.workspaceDir, "spans.jsonl", `${JSON.stringify(record)}\n`);
		if (this.endpoint) this.post([...this.collected]);
		this.collected.length = 0;
	}

	private post(batch: SpanRecord[]): void {
		const endpoint = this.endpoint;
		if (!endpoint) return;
		const body = JSON.stringify({
			resourceSpans: [{ scopeSpans: [{ scope: { name: "lightclaw" }, spans: batch }] }],
		});
		void fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		}).catch(() => {
			// 导出失败只影响可观测性，不能影响任务执行。
		});
	}
}
