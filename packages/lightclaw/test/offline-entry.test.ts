import { readFileSync } from "node:fs";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";

describe("LightClaw offline test entry", () => {
	it("is a mandatory workspace test script", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(pkg.scripts.test).toBe("tsx ../../node_modules/vitest/dist/cli.js --run");
	});
	it("blocks accidental network access even after test mock cleanup", async () => {
		vi.restoreAllMocks();
		expect(homedir()).toContain("lightclaw-offline-home-");
		expect(() => new Socket().connect(443, "example.invalid")).toThrow("Network disabled");
		await expect(fetch("https://example.invalid")).rejects.toThrow("Network disabled");
	});
});
