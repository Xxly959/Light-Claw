import { createHash } from "node:crypto";
import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, renameSync, unlinkSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "./fs-watch.js";
import * as log from "./log.js";
import type { ChatEvent } from "./transport.js";

/**
 * The events watcher only needs to be able to queue an event, so it depends on
 * this narrow shape rather than a concrete bot class.
 */
export interface EventBotTarget {
	enqueueEvent(event: ChatEvent): boolean;
	readonly durableAdmission?: boolean;
}

// ============================================================================
// Event Types
// ============================================================================

export interface ImmediateEvent {
	type: "immediate";
	channelId: string;
	text: string;
}

export interface OneShotEvent {
	type: "one-shot";
	channelId: string;
	text: string;
	at: string; // ISO 8601 with timezone offset
}

export interface PeriodicEvent {
	type: "periodic";
	channelId: string;
	text: string;
	schedule: string; // cron syntax
	timezone: string; // IANA timezone
}

export type LightClawEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** RFC3339-style ISO timestamp with timezone; reject Date.parse's calendar normalization. */
function validOneShotDate(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!parts) return false;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = parts;
	const [year, month, day, hour, minute, second] = [
		yearText,
		monthText,
		dayText,
		hourText,
		minuteText,
		secondText,
	].map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return (
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= days[month - 1] &&
		hour <= 23 &&
		minute <= 59 &&
		second <= 59 &&
		(zone === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59)) &&
		Number.isFinite(Date.parse(value))
	);
}

export class EventsWatcher {
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private crons: Map<string, Cron> = new Map();
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private watcher: FSWatcher | null = null;
	private watcherRetryTimer: NodeJS.Timeout | null = null;
	private knownFiles: Set<string> = new Set();
	private stopped = true;

	constructor(
		private eventsDir: string,
		private slack: EventBotTarget,
	) {}

	/**
	 * Start watching for events. Call this after SlackBot is ready.
	 */
	start(): void {
		this.stopped = false;

		// Ensure events directory exists
		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}

		log.logInfo(`Events watcher starting, dir: ${this.eventsDir}`);

		// Scan existing files
		this.scanExisting();

		this.startFsWatcher();

		log.logInfo(`Events watcher started, tracking ${this.knownFiles.size} files`);
	}

	/**
	 * Stop watching and cancel all scheduled events.
	 */
	stop(): void {
		this.stopped = true;

		// Stop fs watcher
		closeWatcher(this.watcher);
		this.watcher = null;
		if (this.watcherRetryTimer) {
			clearTimeout(this.watcherRetryTimer);
			this.watcherRetryTimer = null;
		}

		// Cancel all debounce timers
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		// Cancel all scheduled timers
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();

		// Cancel all cron jobs
		for (const cron of this.crons.values()) {
			cron.stop();
		}
		this.crons.clear();

		this.knownFiles.clear();
		log.logInfo("Events watcher stopped");
	}

	private startFsWatcher(): void {
		this.watcher = watchWithErrorHandler(
			this.eventsDir,
			(_eventType, filename) => {
				if (!filename || !filename.endsWith(".json")) return;
				this.debounce(filename, () => this.handleFileChange(filename));
			},
			() => this.handleFsWatcherError(),
		);
	}

	private handleFsWatcherError(): void {
		closeWatcher(this.watcher);
		this.watcher = null;
		this.scheduleFsWatcherRetry();
	}

	private scheduleFsWatcherRetry(): void {
		if (this.stopped || this.watcherRetryTimer) {
			return;
		}

		this.watcherRetryTimer = setTimeout(() => {
			this.watcherRetryTimer = null;
			if (this.stopped) {
				return;
			}
			this.startFsWatcher();
			if (this.watcher) {
				this.rescanExisting();
			}
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private debounce(filename: string, fn: () => void): void {
		const existing = this.debounceTimers.get(filename);
		if (existing) {
			clearTimeout(existing);
		}
		this.debounceTimers.set(
			filename,
			setTimeout(() => {
				this.debounceTimers.delete(filename);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	private scanExisting(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			log.logWarning("Failed to read events directory", String(err));
			return;
		}

		for (const filename of files) {
			this.handleFile(filename);
		}
	}

	private rescanExisting(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			log.logWarning("Failed to read events directory", String(err));
			return;
		}

		const currentFiles = new Set(files);
		for (const filename of files) {
			this.handleFileChange(filename);
		}
		for (const filename of Array.from(this.knownFiles)) {
			if (!currentFiles.has(filename)) {
				this.handleDelete(filename);
			}
		}
	}

	private handleFileChange(filename: string): void {
		const filePath = join(this.eventsDir, filename);

		if (!existsSync(filePath)) {
			// File was deleted
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			// File was modified - cancel existing and re-schedule
			this.cancelScheduled(filename);
			this.handleFile(filename);
		} else {
			// New file
			this.handleFile(filename);
		}
	}

	private handleDelete(filename: string): void {
		if (!this.knownFiles.has(filename)) return;

		log.logInfo(`Event file deleted: ${filename}`);
		this.cancelScheduled(filename);
		this.knownFiles.delete(filename);
	}

	private cancelScheduled(filename: string): void {
		const timer = this.timers.get(filename);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(filename);
		}

		const cron = this.crons.get(filename);
		if (cron) {
			cron.stop();
			this.crons.delete(filename);
		}
	}

	private async handleFile(filename: string): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		// Parse with retries
		let event: LightClawEvent | null = null;
		let lastError: Error | null = null;

		for (let i = 0; i < MAX_RETRIES; i++) {
			if (this.stopped) return;
			try {
				const content = await readFile(filePath, "utf-8");
				if (this.stopped) return;
				event = this.parseEvent(content, filename);
				break;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (i < MAX_RETRIES - 1) {
					await this.sleep(RETRY_BASE_MS * 2 ** i);
				}
			}
		}

		if (this.stopped) return;
		if (!event) {
			log.logWarning(`Failed to parse event file after ${MAX_RETRIES} retries: ${filename}`, lastError?.message);
			this.deadLetter(filename);
			return;
		}

		if (this.stopped) return;
		this.knownFiles.add(filename);

		// Schedule based on type
		switch (event.type) {
			case "immediate":
				this.handleImmediate(filename, event);
				break;
			case "one-shot":
				this.handleOneShot(filename, event);
				break;
			case "periodic":
				this.handlePeriodic(filename, event);
				break;
		}
	}

	private parseEvent(content: string, filename: string): LightClawEvent | null {
		const data = JSON.parse(content);

		if (
			!data ||
			typeof data !== "object" ||
			typeof data.type !== "string" ||
			typeof data.channelId !== "string" ||
			!data.channelId.trim() ||
			typeof data.text !== "string" ||
			!data.text.trim()
		) {
			throw new Error(`Missing required fields (type, channelId, text) in ${filename}`);
		}

		switch (data.type) {
			case "immediate":
				return { type: "immediate", channelId: data.channelId, text: data.text };

			case "one-shot":
				if (!validOneShotDate(data.at)) {
					throw new Error(`Invalid 'at' field: expected ISO calendar timestamp with timezone in ${filename}`);
				}
				return { type: "one-shot", channelId: data.channelId, text: data.text, at: data.at };

			case "periodic":
				if (!data.schedule) {
					throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
				}
				if (!data.timezone) {
					throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
				}
				return {
					type: "periodic",
					channelId: data.channelId,
					text: data.text,
					schedule: data.schedule,
					timezone: data.timezone,
				};

			default:
				throw new Error(`Unknown event type '${data.type}' in ${filename}`);
		}
	}

	private handleImmediate(filename: string, event: ImmediateEvent): void {
		log.logInfo(`Executing immediate event: ${filename}`);
		this.execute(filename, event);
	}

	private handleOneShot(filename: string, event: OneShotEvent): void {
		const atTime = new Date(event.at).getTime();
		const now = Date.now();

		if (atTime <= now) {
			// Catch up once after restart regardless of age; durable inbox admission controls expiry/deduplication.
			log.logInfo(`One-shot event overdue, admitting for durable processing: ${filename}`);
			this.execute(filename, event);
			return;
		}

		const delay = atTime - now;
		log.logInfo(`Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s`);

		const scheduleChunk = () => {
			if (this.stopped) return;
			const remaining = atTime - Date.now();
			if (remaining <= 0) {
				this.timers.delete(filename);
				log.logInfo(`Executing one-shot event: ${filename}`);
				this.execute(filename, event);
				return;
			}
			this.timers.set(filename, setTimeout(scheduleChunk, Math.min(remaining, MAX_TIMER_DELAY_MS)));
		};
		scheduleChunk();
	}

	private handlePeriodic(filename: string, event: PeriodicEvent): void {
		try {
			const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
				log.logInfo(`Executing periodic event: ${filename}`);
				this.execute(filename, event, false); // Don't delete periodic events
			});

			this.crons.set(filename, cron);

			const next = cron.nextRun();
			log.logInfo(`Scheduled periodic event: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`);
		} catch (err) {
			log.logWarning(`Invalid cron schedule for ${filename}: ${event.schedule}`, String(err));
			this.deadLetter(filename);
		}
	}

	private execute(filename: string, event: LightClawEvent, deleteAfter: boolean = true): void {
		// Format the message
		let scheduleInfo: string;
		switch (event.type) {
			case "immediate":
				scheduleInfo = "immediate";
				break;
			case "one-shot":
				scheduleInfo = event.at;
				break;
			case "periodic":
				scheduleInfo = event.schedule;
				break;
		}

		const message = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;

		// 创建与消息平台无关的合成事件
		const syntheticEvent: ChatEvent = {
			type: "mention",
			origin: "scheduled",
			channel: event.channelId,
			user: "EVENT",
			text: message,
			ts:
				event.type === "periodic"
					? `${filename}:${Date.now()}`
					: `event-${createHash("sha256")
							.update(JSON.stringify([filename, event]))
							.digest("hex")}`,
		};

		// Enqueue for processing
		const enqueued = this.slack.enqueueEvent(syntheticEvent);

		if (enqueued && deleteAfter && this.slack.durableAdmission === true) {
			// Delete file after successful enqueue (immediate and one-shot)
			this.deleteFile(filename);
		} else if (!enqueued) {
			log.logWarning(`Event not admitted; source retained: ${filename}`);
		}
	}

	private deadLetter(filename: string): void {
		const directory = join(this.eventsDir, "dead-letter");
		mkdirSync(directory, { recursive: true });
		try {
			renameSync(join(this.eventsDir, filename), join(directory, `${Date.now()}-${filename}`));
		} catch (error) {
			log.logWarning(`Event dead-letter failed: ${filename}`, String(error));
		}
		this.knownFiles.delete(filename);
	}

	private deleteFile(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		try {
			unlinkSync(filePath);
		} catch (err) {
			// ENOENT is fine (file already deleted), other errors are warnings
			if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
				log.logWarning(`Failed to delete event file: ${filename}`, String(err));
			}
		}
		this.knownFiles.delete(filename);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Create and start an events watcher.
 */
export function createEventsWatcher(workspaceDir: string, slack: EventBotTarget): EventsWatcher {
	const eventsDir = join(workspaceDir, "events");
	return new EventsWatcher(eventsDir, slack);
}
