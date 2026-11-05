import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isWithin, physicalPath } from "../../goals/control.js";
import { type SandboxConfig, validateSandbox } from "../../sandbox.js";

interface TaskSandboxOptions {
	taskDir: string;
	protectedDirs: string[];
	image: string;
}
const label = "io.lightclaw.reliability-task";
function docker(args: string[]): string {
	return execFileSync("docker", args, {
		encoding: "utf8",
		timeout: 15000,
		maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
export function makeTaskSandboxPlan(options: TaskSandboxOptions) {
	const root = physicalPath(options.taskDir);
	if (!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(options.image))
		throw new Error("Evaluation image requires a frozen digest; no pull/build implicit");
	if (/[,\r\n]/.test(root) || !lstatSync(root).isDirectory()) throw new Error("Invalid task directory");
	for (const path of options.protectedDirs) {
		const protectedPath = physicalPath(path);
		if (isWithin(root, protectedPath) || isWithin(protectedPath, root))
			throw new Error("Task mount overlaps protected evaluator/source/control path");
	}
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name),
				info = lstatSync(path);
			if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1))
				throw new Error("Task assets must be plain files without links/sockets");
			if (info.isDirectory()) walk(path);
		}
	};
	walk(root);
	const id = randomUUID(),
		name = `lightclaw-eval-${id}`;
	const args = [
		"create",
		"--pull=never",
		"--name",
		name,
		"--label",
		`${label}=${id}`,
		"--network=none",
		"--read-only",
		"--cpus=1",
		"--memory=256m",
		"--memory-swap=256m",
		"--pids-limit=64",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges:true",
		"--user",
		`${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
		"--tmpfs",
		"/tmp:rw,nosuid,nodev,size=32m",
		"--mount",
		`type=bind,source=${root},target=/workspace`,
		"--entrypoint",
		"/bin/sh",
		options.image,
		"-c",
		"while :; do sleep 3600; done",
	];
	return { args, name, id, taskDir: root, image: options.image };
}
export async function startTaskSandbox(options: TaskSandboxOptions) {
	const plan = makeTaskSandboxPlan(options);
	const id = docker(plan.args);
	if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid Docker container ID");
	const config: Extract<SandboxConfig, { type: "docker" }> = { type: "docker", container: id };
	const dispose = async () => {
		const owner = docker(["inspect", "--format", `{{index .Config.Labels "${label}"}}`, id]);
		if (owner !== plan.id) throw new Error("Refusing cleanup of unowned task container");
		docker(["rm", "-f", id]);
	};
	try {
		docker(["start", id]);
		const details = JSON.parse(docker(["inspect", id])) as Array<{
			HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string };
			Image: string;
		}>;
		if (
			details.length !== 1 ||
			details[0].HostConfig.ReadonlyRootfs !== true ||
			details[0].HostConfig.NetworkMode !== "none"
		)
			throw new Error("Task container contract mismatch");
		await validateSandbox(config, plan.taskDir, true);
		return { config, plan, checkedAt: new Date().toISOString(), dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}
