/** Diagnostic sinks only. Authoritative messages, goals and model tool results remain intact. */
export function redactSecrets(text: string): string {
	return text
		.replace(/-----BEGIN [^-\r\n]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-\r\n]+-----/g, "[REDACTED PEM]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED]")
		.replace(/\bBearer\s+[^\s;,"'<>]+/gi, "Bearer [REDACTED]")
		.replace(
			/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|passwd|secret|app[_-]?secret|client[_-]?secret|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&,}\r\n]+)/gi,
			"$1[REDACTED]",
		)
		.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(
			/([?&](?:token|key|api_key|access_token|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#\s]+/gi,
			"$1[REDACTED]",
		);
}

export function debugPayloadsEnabled(): boolean {
	return process.env.LIGHTCLAW_DEBUG_PAYLOADS === "1";
}

export function boundedRedactedText(text: string, maxBytes = 4096): string {
	const redacted = redactSecrets(text);
	const bytes = Buffer.from(redacted);
	return bytes.length <= maxBytes ? redacted : `${bytes.subarray(0, maxBytes).toString("utf8")}\n[truncated]`;
}

export function diagnosticText(text: string): string {
	return debugPayloadsEnabled() ? boundedRedactedText(text) : `[payload omitted; ${Buffer.byteLength(text)} bytes]`;
}

export function redactDiagnosticValue(value: unknown): unknown {
	let remaining = 64 * 1024;
	let nodes = 2048;
	const visit = (item: unknown, depth: number): unknown => {
		if (depth > 12 || --nodes < 0 || remaining <= 0) return "[diagnostic limit]";
		if (typeof item === "string") {
			const text = boundedRedactedText(item, Math.min(4096, remaining));
			remaining -= Buffer.byteLength(text);
			return text;
		}
		if (Array.isArray(item)) return item.slice(0, 100).map((entry) => visit(entry, depth + 1));
		if (item && typeof item === "object") {
			return Object.fromEntries(
				Object.entries(item)
					.slice(0, 100)
					.map(([key, entry]) => [
						boundedRedactedText(key, 128),
						/^(?:.*(?:password|secret|token|api[_-]?key)|authorization|cookie)$/i.test(key)
							? "[REDACTED]"
							: visit(entry, depth + 1),
					]),
			);
		}
		return item;
	};
	return visit(value, 0);
}
