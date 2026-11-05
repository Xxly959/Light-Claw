import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfigForDiagnostics } from "../src/config.js";
import { buildIsolationReport } from "../src/isolation.js";

const fake = vi.hoisted(() => ({ inspect: vi.fn(), channel: vi.fn(), shared: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: fake.inspect }));
vi.mock("../src/sandbox.js", () => ({ validateChannelSandbox: fake.channel, validateSandbox: fake.shared }));
const roots: string[] = [];
afterEach(() => {
	vi.resetAllMocks();
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "isolation-report-"));
	roots.push(root);
	mkdirSync(join(root, "work", "C1"), { recursive: true });
	mkdirSync(join(root, "work", "C2"));
	return {
		workingDir: join(root, "work"),
		controlDir: join(root, "control"),
		sandbox: { type: "docker" as const, container: "shared" },
		config: { ...loadConfigForDiagnostics({}), channelContainers: { C1: "one", C2: "two" } },
	};
}
it("inspects each dedicated container with its own network and full contract", async () => {
	const options = fixture();
	fake.inspect.mockImplementation((_cmd, args) =>
		JSON.stringify([
			{ State: { Running: true }, HostConfig: { NetworkMode: args[1] === "one" ? "none" : "bridge" } },
		]),
	);
	fake.channel.mockResolvedValue(undefined);
	fake.shared.mockResolvedValue(undefined);
	const report = await buildIsolationReport(options);
	expect(report.containers.find((item) => item.container === "one")?.networkMode).toBe("none");
	expect(report.containers.find((item) => item.container === "two")?.networkMode).toBe("bridge");
	expect(report.verifiedChannelContainers).toBe(2);
	expect(fake.channel).toHaveBeenCalledTimes(2);
});
it("does not turn configured mappings into verified isolation", async () => {
	const options = fixture();
	fake.inspect.mockImplementation(() => {
		throw new Error("No such object");
	});
	const report = await buildIsolationReport(options);
	expect(report.channelIsolation).toBe("unverified");
	expect(report.verifiedChannelContainers).toBe(0);
	expect(report.containers.every((item) => item.status === "missing")).toBe(true);
});
it("reports stopped, inspection failure and contract mismatch separately", async () => {
	const options = fixture();
	fake.inspect.mockImplementation((_cmd, args) => {
		if (args[1] === "one") return JSON.stringify([{ State: { Running: false } }]);
		if (args[1] === "shared") throw new Error("daemon unreachable");
		return JSON.stringify([{ State: { Running: true }, HostConfig: { NetworkMode: "none" } }]);
	});
	fake.channel.mockRejectedValue(new Error("wrong mount"));
	const report = await buildIsolationReport(options);
	expect(report.containers.map((item) => item.status)).toEqual(["inspection_failed", "stopped", "contract_mismatch"]);
	expect(report.verifiedChannelContainers).toBe(0);
});
