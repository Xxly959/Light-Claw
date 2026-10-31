import * as log from "./log.js";
import { appendAuditEvent } from "./observability.js";
import { withTimeout } from "./timeouts.js";

/** Observe immediate socket callbacks without delaying acknowledgement or stop. */
export async function observePlatformOperation(
	operation: () => Promise<unknown>,
	workingDir: string,
	channelId: string,
	timeoutMs: number,
	label: string,
): Promise<void> {
	try {
		await withTimeout(operation, timeoutMs, label);
	} catch (error) {
		const detail = `${label}: ${error instanceof Error ? error.message : String(error)}`;
		log.logWarning(`[${channelId}] Platform operation failed`, detail);
		try {
			appendAuditEvent(workingDir, { type: "delivery_failed", channelId, detail });
		} catch (auditError) {
			log.logWarning(
				`[${channelId}] Delivery audit failed`,
				auditError instanceof Error ? auditError.message : String(auditError),
			);
		}
	}
}
