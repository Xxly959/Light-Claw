export interface ModelHttpTrace {
	phase: "request" | "response" | "complete" | "network_error";
	elapsedMs: number;
	configuredKeyMatches?: boolean;
	requestBodyBytes?: number;
	messageCount?: number;
	toolCount?: number;
	maxTokens?: number;
	stream?: boolean;
	bodyKind?: "sse" | "json" | "html" | "other" | "empty";
	jsonFields?: string[];
	sseSubstringPresent?: boolean;
	httpStatus?: number;
	contentType?: string;
	contentEncoding?: string;
	responseBytes: number;
	sseDataLines: number;
	textCharacters: number;
	toolCallDeltas: number;
	reportedTotalTokens?: number;
	truncated?: boolean;
	readFailed?: boolean;
}

/** One-shot opt-in observation: pass the original Response through unchanged; retain scalar metadata only. */
export function instrumentModelFetch(options: {
	fetch: typeof fetch;
	origin: string;
	expectedApiKey?: string;
	onTrace(trace: ModelHttpTrace): void;
}): typeof fetch {
	let observed = false;
	return async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (observed || url.origin !== options.origin || !url.pathname.endsWith("/chat/completions"))
			return options.fetch(input, init);
		observed = true;
		const started = performance.now();
		const trace: ModelHttpTrace = {
			phase: "request",
			elapsedMs: 0,
			responseBytes: 0,
			sseDataLines: 0,
			textCharacters: 0,
			toolCallDeltas: 0,
		};
		const emit = () => {
			trace.elapsedMs = Math.round(performance.now() - started);
			try {
				options.onTrace({ ...trace });
			} catch {
				/* Diagnostics must not change request delivery. */
			}
		};
		try {
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			new Headers(init?.headers).forEach((value, key) => {
				headers.set(key, value);
			});
			if (options.expectedApiKey)
				trace.configuredKeyMatches = headers.get("authorization") === `Bearer ${options.expectedApiKey}`;
			if (typeof init?.body === "string") {
				trace.requestBodyBytes = Buffer.byteLength(init.body);
				if (trace.requestBodyBytes <= 100000) {
					const body: unknown = JSON.parse(init.body);
					if (typeof body === "object" && body !== null) {
						const data = body as Record<string, unknown>;
						if (Array.isArray(data.messages)) trace.messageCount = data.messages.length;
						if (Array.isArray(data.tools)) trace.toolCount = data.tools.length;
						if (typeof data.max_tokens === "number") trace.maxTokens = data.max_tokens;
						if (typeof data.stream === "boolean") trace.stream = data.stream;
					}
				}
			}
		} catch {
			/* Metadata unavailable; preserve normal fetch behavior. */
		}
		emit();
		let response: Response;
		try {
			response = await options.fetch(input, init);
		} catch (error) {
			trace.phase = "network_error";
			emit();
			throw error;
		}
		trace.phase = "response";
		trace.httpStatus = response.status;
		trace.contentType = response.headers.get("content-type")?.split(";")[0];
		trace.contentEncoding = response.headers.get("content-encoding") ?? undefined;
		emit();
		const observe = async () => {
			const reader = response.clone().body?.getReader();
			if (!reader) {
				trace.phase = "complete";
				emit();
				return;
			}
			const decoder = new TextDecoder();
			let prefix = "";
			let pending = "";
			let dropping = false;
			const line = (value: string) => {
				if (!value.startsWith("data:")) return;
				trace.sseDataLines++;
				try {
					const data = JSON.parse(value.slice(5)) as {
						choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown[] } }>;
						usage?: { total_tokens?: unknown };
					};
					for (const choice of data.choices ?? []) {
						if (typeof choice.delta?.content === "string") trace.textCharacters += choice.delta.content.length;
						trace.toolCallDeltas += choice.delta?.tool_calls?.length ?? 0;
					}
					if (typeof data.usage?.total_tokens === "number") trace.reportedTotalTokens = data.usage.total_tokens;
				} catch {
					/* Ignore malformed lines and DONE without retaining payloads. */
				}
			};
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					trace.responseBytes += chunk.value.length;
					const decoded = decoder.decode(chunk.value, { stream: true });
					if (prefix.length < 32768) prefix += decoded.slice(0, 32768 - prefix.length);
					for (const ch of decoded) {
						if (ch === "\n") {
							if (!dropping) line(pending.trimEnd());
							pending = "";
							dropping = false;
						} else if (!dropping) {
							pending += ch;
							if (pending.length > 8192) {
								pending = "";
								dropping = true;
							}
						}
					}
					if (trace.responseBytes > 1048576) {
						trace.truncated = true;
						void reader.cancel().catch(() => {});
						break;
					}
				}
			} catch {
				trace.readFailed = true;
			}
			trace.bodyKind = /^\s*data:/.test(prefix)
				? "sse"
				: /^\s*[[{]/.test(prefix)
					? "json"
					: /^\s*</.test(prefix)
						? "html"
						: prefix.length
							? "other"
							: "empty";
			trace.sseSubstringPresent = prefix.includes("data:");
			if (trace.bodyKind === "json")
				try {
					const value: unknown = JSON.parse(prefix);
					if (value && typeof value === "object")
						trace.jsonFields = Object.keys(value).filter((k) =>
							[
								"id",
								"object",
								"choices",
								"error",
								"code",
								"message",
								"data",
								"type",
								"response",
								"status",
							].includes(k),
						);
				} catch {}
			trace.phase = "complete";
			emit();
		};
		void observe().catch(() => {
			trace.phase = "complete";
			trace.readFailed = true;
			emit();
		});
		return response;
	};
}
