import type { LogLevel } from "@slack/web-api";
import { logWarning } from "./log.js";
import { debugPayloadsEnabled, diagnosticText, redactDiagnosticValue } from "./redaction.js";

/** SDKs may hand us complete HTTP request/response objects. Never forward them to their default console logger. */
export function createSdkLogger(platform: string) {
	let level = "warn" as LogLevel;
	let windowStart = Date.now();
	let count = 0;
	const write = (severity: string, values: unknown[]) => {
		if (severity !== "warn" && severity !== "error" && !debugPayloadsEnabled()) return;
		if (Date.now() - windowStart > 60_000) {
			windowStart = Date.now();
			count = 0;
		}
		if (++count > 20) return;
		// Error.message is diagnostic content too; do not expose stack/request internals by serialization.
		const text = debugPayloadsEnabled()
			? JSON.stringify(
					redactDiagnosticValue(values.map((value) => (value instanceof Error ? value.message : value))),
				)
			: "SDK diagnostic payload omitted";
		logWarning(`[${platform}] SDK ${severity}`, diagnosticText(text));
	};
	return {
		debug: (...values: unknown[]) => write("debug", values),
		trace: (...values: unknown[]) => write("trace", values),
		info: (...values: unknown[]) => write("info", values),
		warn: (...values: unknown[]) => write("warn", values),
		error: (...values: unknown[]) => write("error", values),
		setLevel: (value: LogLevel) => {
			level = value;
		},
		getLevel: () => level,
		setName: (_name: string) => {},
	};
}
