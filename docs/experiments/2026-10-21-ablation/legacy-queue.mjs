import * as log from "../../../packages/lightclaw/src/log.ts";

export class LegacyQueue {
	queue = [];
	processing = false;

	enqueue(work) {
		this.queue.push(work);
		this.processNext();
	}

	size() {
		return this.queue.length;
	}

	async processNext() {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift();
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

