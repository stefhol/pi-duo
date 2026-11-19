/**
 * Manual smoke test against a real GitLab instance.
 *
 * Reads credentials the same way the extension does: the stored `gitlab-duo`
 * credential first, then GITLAB_HOST / GITLAB_TOKEN.
 *
 * Run:
 *   node smoke.ts                          # default model
 *   node smoke.ts claude-sonnet-4-5-20250929 --thinking
 *   GITLAB_HOST=https://gitlab.example.com GITLAB_TOKEN=glpat-... node smoke.ts gpt-5.1-2025-11-13
 */

import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { MODELS, gitlabHost, streamGitLabDuo } from "./index.ts";

interface StoredDuoCredential {
	access?: string;
	instanceUrl?: string;
	refresh?: string;
}

const MODEL_MAP = new Map(MODELS.map((model) => [model.id, model]));

function credentials(): { token: string; host: string } {
	const stored = readStoredCredential("gitlab-duo") as StoredDuoCredential | undefined;
	const host = gitlabHost();
	const token = stored?.access ?? process.env.GITLAB_TOKEN;
	if (!token) throw new Error("No GitLab credentials. Run /login gitlab-duo or set GITLAB_HOST + GITLAB_TOKEN.");
	return { token, host };
}

async function main() {
	const modelId = process.argv[2] ?? "claude-sonnet-4-5-20250929";
	const thinking = process.argv.includes("--thinking");
	const cfg = MODEL_MAP.get(modelId);
	if (!cfg) {
		console.error(`Unknown model: ${modelId}`);
		console.error("Available:", [...MODEL_MAP.keys()].join(", "));
		process.exit(1);
	}

	const { token, host } = credentials();
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
