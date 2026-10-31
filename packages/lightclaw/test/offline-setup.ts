import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// No inherited credentials or user auth/config files in the offline suite.
const testHome = mkdtempSync(join(tmpdir(), "lightclaw-offline-home-"));
for (const key of Object.keys(process.env)) {
	if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete process.env[key];
}
process.env.HOME = testHome;
process.env.PI_CODING_AGENT_DIR = join(testHome, ".pi", "agent");
process.env.LIGHTCLAW_OFFLINE_TEST = "1";

// Direct assignments survive test-local vi.restoreAllMocks(). Mock SDKs/providers instead.
Socket.prototype.connect = () => {
	throw new Error("Network disabled in LightClaw offline tests");
};
globalThis.fetch = async () => {
	throw new Error("Network disabled in LightClaw offline tests");
};
afterAll(() => rmSync(testHome, { recursive: true, force: true }));
