import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertControlIsolation } from "../src/goals/control.js";
import { validateSandbox } from "../src/sandbox.js";

const roots: string[] = [];

const docker = vi.hoisted(() => ({
	inspect: {} as Record<string, unknown>,
	uid: "1000\n",
	groups: "1000\n",
	calls: [] as string[][],
	probe: "normal",
	kills: [] as string[],
}));
vi.mock("node:child_process", () => ({
	execFileSync: () => JSON.stringify([docker.inspect]),
	spawn: (_program: string, args: string[]) => {
		docker.calls.push(args);
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: (signal: string) => {
				docker.kills.push(signal);
				return true;
			},
		});
		queueMicrotask(() => {
			if (args[0] === "exec" && docker.probe === "hang") return;
			if (args[0] === "exec" && docker.probe === "oversize") {
				child.stdout.end("x".repeat(600 * 1024));
				child.stderr.end("x".repeat(600 * 1024));
				child.emit("close", 0);
				return;
			}
			child.stdout.end(
				args[0] === "--version"
					? "Docker offline fixture"
					: args[0] === "inspect"
						? JSON.stringify([docker.inspect])
						: args.at(-1) === "-G"
							? docker.groups
							: docker.uid,
			);
			child.emit("close", 0);
		});
		return child;
	},
}));
beforeEach(() => {
	vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("unexpected process exit");
	});
	docker.uid = "1000\n";
	docker.groups = "1000\n";
	docker.calls = [];
	docker.probe = "normal";
	docker.kills = [];
	docker.inspect = {
		State: { Running: true },
		Config: { User: "1000:1000" },
		HostConfig: {
			Privileged: false,
			CapDrop: ["ALL"],
			CapAdd: [],
			SecurityOpt: ["no-new-privileges:true"],
			NetworkMode: "bridge",
			PidMode: "",
			IpcMode: "private",
			UTSMode: "",
			UsernsMode: "",
			Devices: [],
			DeviceRequests: [],
			Memory: 536870912,
			MemorySwap: 536870912,
			NanoCpus: 1e9,
			PidsLimit: 128,
		},
		Mounts: [
			{ Type: "bind", Source: "/tmp/workspace", Destination: "/workspace", RW: true, Propagation: "rprivate" },
			{ Type: "tmpfs", Source: "", Destination: "/tmp", RW: true },
		],
	};
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const config = { type: "docker", container: "offline-fixture" } as const;
it("accepts the bounded docker.sh configuration after checking actual runtime UID", async () => {
	await validateSandbox(config);
	expect(docker.calls.some((args) => args[0] === "exec" && args.includes("-u"))).toBe(true);
});
it("preserves configured custom network names", async () => {
	(docker.inspect.HostConfig as Record<string, unknown>).NetworkMode = "personal-agent-network";
	await validateSandbox(config);
});
it("accepts real inspect tmpfs shape through both startup policy and control isolation", async () => {
	const root = mkdtempSync(join(tmpdir(), "docker-startup-chain-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const control = join(root, "control");
	mkdirSync(workspace);
	mkdirSync(control);
	(docker.inspect.Mounts as Array<Record<string, unknown>>)[0].Source = workspace;
	await validateSandbox(config, workspace);
	await expect(assertControlIsolation(workspace, control, config)).resolves.toBeUndefined();
	for (const destination of ["/workspace/control", "/control"]) {
		(docker.inspect.Mounts as Array<Record<string, unknown>>)[1].Destination = destination;
		await expect(assertControlIsolation(workspace, control, config)).rejects.toThrow();
	}
});
it("kills a hanging Docker identity probe at the ten second startup deadline", async () => {
	vi.useFakeTimers();
	docker.probe = "hang";
	const pending = validateSandbox(config);
	const rejected = expect(pending).rejects.toThrow(/timed out/);
	await vi.advanceTimersByTimeAsync(10_001);
	await rejected;
	expect(docker.kills).toEqual(["SIGKILL"]);
});
it("kills Docker identity probes exceeding the combined stdout/stderr one MiB cap", async () => {
	docker.probe = "oversize";
	await expect(validateSandbox(config)).rejects.toThrow(/output.*limit/);
	expect(docker.kills).toEqual(["SIGKILL"]);
});
it.each(["", "root", "0", "0:1000"])("rejects configured root identity %s", async (user) => {
	docker.inspect.Config = { User: user };
	await expect(validateSandbox(config)).rejects.toThrow(/root|non-root/);
});
it("rejects a non-root name that resolves to actual root", async () => {
	docker.inspect.Config = { User: "pretend-user" };
	docker.uid = "0\n";
	await expect(validateSandbox(config)).rejects.toThrow(/root|UID/);
});
it("rejects supplementary root group access", async () => {
	docker.groups = "1000 0\n";
	await expect(validateSandbox(config)).rejects.toThrow("root");
});
it.each([
	["Privileged", true],
	["CapAdd", ["SYS_ADMIN"]],
	["CapDrop", []],
	["SecurityOpt", []],
	["NetworkMode", "host"],
	["PidMode", "host"],
	["PidMode", "container:other"],
	["Devices", [{ PathOnHost: "/dev/sda" }]],
	["Memory", 0],
	["MemorySwap", -1],
	["NanoCpus", 0],
	["PidsLimit", 0],
] as const)("rejects unsafe/unbounded HostConfig %s", async (key, value) => {
	const host = docker.inspect.HostConfig as Record<string, unknown>;
	host[key] = value;
	await expect(validateSandbox(config)).rejects.toThrow(/sandbox/);
});
it.each(["/", "/var/run/docker.sock", "/etc"])("rejects dangerous host mount %s", async (source) => {
	docker.inspect.Mounts = [{ Type: "bind", Source: source, Destination: "/workspace", RW: true }];
	await expect(validateSandbox(config)).rejects.toThrow(/mount|sandbox/);
});
it("rejects arbitrary mounts beyond workspace and tmpfs", async () => {
	(docker.inspect.Mounts as unknown[]).push({ Type: "bind", Source: "/tmp/secret", Destination: "/secrets" });
	await expect(validateSandbox(config)).rejects.toThrow(/mount|sandbox/);
});
