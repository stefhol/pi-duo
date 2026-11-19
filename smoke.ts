/**
 * Manual smoke test against a real GitLab instance.
 *
 * Reads credentials the same way the extension does: the stored `gitlab-duo`
 * credential first, then GITLAB_HOST / GITLAB_TOKEN.
 *
 * Run:
 *   node smoke.ts --list                    # what this instance's gateway serves
 *   node smoke.ts                           # default model
 *   node smoke.ts claude-sonnet-4-5-20250929 --thinking
 *   GITLAB_HOST=https://gitlab.example.com GITLAB_TOKEN=glpat-... node smoke.ts gpt-6.1-sol-2026-01-15
 */

import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { discoverModels, gitlabHost, modelCatalog, modelConfig, streamGitLabDuo } from "./index.ts";

interface StoredDuoCredential {
	access?: string;
	instanceUrl?: string;
	refresh?: string;
}

function credentials(): { token: string; host: string } {
	const stored = readStoredCredential("gitlab-duo") as StoredDuoCredential | undefined;
	const host = gitlabHost();
	const token = stored?.access ?? process.env.GITLAB_TOKEN;
	if (!token) throw new Error("No GitLab credentials. Run /login gitlab-duo or set GITLAB_HOST + GITLAB_TOKEN.");
	return { token, host };
}

async function main() {
	const args = process.argv.slice(2);
	const thinking = args.includes("--thinking");
	const modelId = args.find((argument) => !argument.startsWith("--")) ?? "claude-sonnet-4-5-20250929";
	const { token, host } = credentials();

	if (args.includes("--list")) {
		const models = await discoverModels(token);
		console.log(`${models.length} models discovered on ${host}:`);
		for (const entry of models) {
			console.log(`  ${entry.backend.padEnd(9)} ${entry.id.padEnd(40)} ${entry.name}`);
		}
		return;
	}

	const cfg = modelConfig(modelId);
	console.log(`Instance: ${host}`);
	console.log(`Model: ${cfg.id} (${cfg.backend}${thinking ? ", thinking" : ""})`);

	const model = {
		id: cfg.id,
		name: cfg.name,
		api: "gitlab-duo-api" as const,
		provider: "gitlab-duo",
		baseUrl: cfg.baseUrl,
		reasoning: cfg.reasoning,
		input: cfg.input,
		cost: cfg.cost,
		contextWindow: cfg.contextWindow,
		maxTokens: cfg.maxTokens,
	};

	const stream = streamGitLabDuo(
		model as never,
		{ messages: [{ role: "user", content: "Say hello in exactly 3 words.", timestamp: Date.now() }] } as never,
		{ apiKey: token, maxTokens: 128, reasoning: thinking ? "low" : undefined },
	);

	for await (const event of stream) {
		if (event.type === "thinking_delta") process.stdout.write(event.delta);
		else if (event.type === "text_delta") process.stdout.write(event.delta);
		else if (event.type === "error") {
			console.error("\nError:", event.error.errorMessage);
			console.error("Known ids:", modelCatalog().map((entry) => entry.id).join(", "));
			process.exitCode = 1;
		} else if (event.type === "done") {
			console.log("\nDone:", event.reason, event.message.usage);
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
