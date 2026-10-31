import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { environment: "node", testTimeout: 30_000, include: ["test/**/*.test.ts"], setupFiles: ["./test/offline-setup.ts"] },
	resolve: {
		alias: [
			{ find: /^@mariozechner\/pi-ai$/, replacement: fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)) },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url)) },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)) },
			{ find: /^@mariozechner\/pi-coding-agent$/, replacement: fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url)) },
		],
	},
});
