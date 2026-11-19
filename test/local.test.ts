/**
 * Offline tests for the GitLab Duo provider extension.
 *
 * A local HTTP server stands in for both the GitLab instance (`/api/v4/...`)
 * and the AI gateway (`/ai/v1/proxy/...`), so login, token minting, caching and
 * streaming can be exercised without a GitLab instance.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { startMockGitLab, type Recorded } from "./mock.ts";

const mock = await startMockGitLab();
const requests: Recorded[] = mock.requests;
const state = mock.state;
const gateway = mock.baseUrl;

let agentDir: string;
let mod: typeof import("../index.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loginCallbacks(answers: string[], progress: string[] = []) {
	let index = 0;
	return {
		onAuth: () => {},
		onDeviceCode: () => {},
		onSelect: async () => undefined,
		onProgress: (message: string) => progress.push(message),
		onPrompt: async () => {
			const answer = answers[index++];
			assert.notEqual(answer, undefined, "login asked for more input than the test provided");
			return answer as string;
		},
		signal: new AbortController().signal,
	};
}

async function storeCredential(credential: Record<string, unknown>) {
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "gitlab-duo": credential }, null, 2));
}

async function consume(stream: AsyncIterable<any>) {
	const events: any[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function model(id: string) {
	return mod.MODELS.find((entry) => entry.id === id) as (typeof mod.MODELS)[number];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

before(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-duo-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.GITLAB_AI_GATEWAY_URL = gateway;
	delete process.env.GITLAB_HOST;
	delete process.env.GITLAB_URL;
	delete process.env.GITLAB_TOKEN;
	delete process.env.GITLAB_PROJECT_ID;
	delete process.env.GITLAB_DUO_PROJECT_CONTEXT;
	delete process.env.GITLAB_DUO_ENTITLEMENT_PRECHECK;

	mod = await import("../index.ts");
});

after(async () => {
	await mock.close();
});

describe("normalizeHost", () => {
	it("adds a scheme and drops trailing slashes", () => {
		assert.equal(mod.normalizeHost("gitlab.example.com"), "https://gitlab.example.com");
		assert.equal(mod.normalizeHost("  gitlab.example.com/  "), "https://gitlab.example.com");
		assert.equal(mod.normalizeHost("http://gitlab.local:8080///"), "http://gitlab.local:8080");
		assert.equal(mod.normalizeHost("HTTPS://GitLab.example.com"), "HTTPS://GitLab.example.com");
	});
});

describe("loginGitLabPat", () => {
	it("validates the PAT against the entered instance and stores URL + token", async () => {
		state.userStatus = 200;
		const progress: string[] = [];
		const credential = await mod.loginGitLabPat(loginCallbacks([gateway, "glpat-test"], progress) as any);

		assert.equal(credential.access, "glpat-test");
		assert.equal(credential.instanceUrl, gateway);
		assert.equal(credential.refresh, gateway);
		assert.ok(credential.expires > Date.now() + 9 * 365 * 24 * 3600 * 1000);
		assert.ok(progress.some((line) => line.includes("duo-user")));
	});

	it("rejects a bad PAT and stores nothing", async () => {
		state.userStatus = 401;
		await assert.rejects(
			mod.loginGitLabPat(loginCallbacks([gateway, "glpat-bad"]) as any),
			/GitLab rejected the token .*401.*api scope/,
		);
		state.userStatus = 200;
	});

	it("rejects an unreachable host with a clear error", async () => {
		await assert.rejects(
			mod.loginGitLabPat(loginCallbacks(["http://127.0.0.1:1", "glpat-test"]) as any),
			/Could not reach GitLab at http:\/\/127\.0\.0\.1:1/,
		);
	});

	it("rejects an empty token", async () => {
		await assert.rejects(mod.loginGitLabPat(loginCallbacks([gateway, "   "]) as any), /No personal access token/);
	});

	it("falls back to GITLAB_HOST when the URL prompt is empty", async () => {
		process.env.GITLAB_HOST = gateway;
		try {
			const credential = await mod.loginGitLabPat(loginCallbacks(["", "glpat-test"]) as any);
			assert.equal(credential.instanceUrl, gateway);
		} finally {
			delete process.env.GITLAB_HOST;
		}
	});

	it("runs the entitlement pre-check only when asked", async () => {
		const before = requests.filter((r) => r.path.endsWith("third_party_agents/direct_access")).length;
		await mod.loginGitLabPat(loginCallbacks([gateway, "glpat-test"]) as any);
		const withoutPrecheck = requests.filter((r) => r.path.endsWith("third_party_agents/direct_access")).length;
		assert.equal(withoutPrecheck, before, "no direct_access call by default");

		process.env.GITLAB_DUO_ENTITLEMENT_PRECHECK = "1";
		try {
			await mod.loginGitLabPat(loginCallbacks([gateway, "glpat-test"]) as any);
		} finally {
			delete process.env.GITLAB_DUO_ENTITLEMENT_PRECHECK;
		}
		const withPrecheck = requests.filter((r) => r.path.endsWith("third_party_agents/direct_access")).length;
		assert.equal(withPrecheck, withoutPrecheck + 1);
	});
});

describe("gitlabHost", () => {
	it("prefers the stored credential over the environment", async () => {
		await storeCredential({ type: "oauth", access: "glpat-test", refresh: gateway, expires: Date.now() + 1e12 });
		process.env.GITLAB_HOST = "https://env.example.com";
		try {
			assert.equal(mod.gitlabHost(), gateway);
		} finally {
			delete process.env.GITLAB_HOST;
		}
	});

	it("falls back to refresh when instanceUrl is missing", async () => {
		await storeCredential({ type: "oauth", access: "glpat-test", refresh: gateway, expires: Date.now() + 1e12 });
		assert.equal(mod.gitlabHost(), gateway);
	});

	it("uses the environment when no credential is stored", async () => {
		await storeCredential({});
		// overwrite with a credential for a different provider only
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "x" } }));
		process.env.GITLAB_HOST = "https://env.example.com";
		try {
			assert.equal(mod.gitlabHost(), "https://env.example.com");
		} finally {
			delete process.env.GITLAB_HOST;
		}
		assert.equal(mod.gitlabHost(), "https://gitlab.com");
	});
});

describe("streamGitLabDuo", () => {
	before(async () => {
		await storeCredential({
			type: "oauth",
			access: "glpat-test",
			instanceUrl: gateway,
			refresh: gateway,
			expires: Date.now() + 1e12,
		});
	});

	it("streams an Anthropic-backed model through the gateway proxy", async () => {
		requests.length = 0;
		state.tokenSerial = 0;
		state.expiresAt = undefined;
		mod.invalidateDirectAccessToken();
		const cfg = model("claude-sonnet-4-5-20250929");
		const events = await consume(
			mod.streamGitLabDuo(
				{
					id: cfg.id,
					name: cfg.name,
					api: "gitlab-duo-api" as any,
					provider: "gitlab-duo",
					baseUrl: cfg.baseUrl,
					reasoning: cfg.reasoning,
					input: cfg.input,
					cost: cfg.cost,
					contextWindow: cfg.contextWindow,
					maxTokens: cfg.maxTokens,
				} as any,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any,
				{ apiKey: "glpat-test", maxTokens: 32 },
			),
		);

		const textError = events.find((event) => event.type === "error");
		assert.equal(textError, undefined, textError?.error?.errorMessage);
		const text = events
			.filter((event) => event.type === "text_delta")
			.map((event) => event.delta)
			.join("");
		assert.equal(text, "Hello from the fake gateway");

		const tokenRequest = requests.find((r) => r.path.endsWith("third_party_agents/direct_access"));
		assert.ok(tokenRequest, "expected a direct access token request");
		assert.equal(tokenRequest.method, "POST");
		assert.equal(tokenRequest.headers.authorization, "Bearer glpat-test");

		const proxyRequest = requests.find((r) => r.path.startsWith("/ai/v1/proxy/anthropic/"));
		assert.ok(proxyRequest, "expected a proxy request");
		assert.equal(proxyRequest.path, "/ai/v1/proxy/anthropic/v1/messages");
		// directAccess.headers must win and the gateway token must be the bearer.
		assert.equal(proxyRequest.headers.authorization, "Bearer gateway-token-1");
		assert.equal(proxyRequest.headers["x-gitlab-unit-primitive"], "ai_gateway_model_provider_proxy");
		assert.equal(proxyRequest.headers["x-gitlab-realm"], "self-managed");
	});

	it("reuses the minted token until it expires, then re-mints", async () => {
		requests.length = 0;
		state.tokenSerial = 0;
		state.expiresAt = undefined;
		mod.invalidateDirectAccessToken();
		const cfg = model("claude-sonnet-4-5-20250929");
		const stream = () =>
			mod.streamGitLabDuo(
				{
					id: cfg.id,
					name: cfg.name,
					api: "gitlab-duo-api" as any,
					provider: "gitlab-duo",
					baseUrl: cfg.baseUrl,
					reasoning: false,
					input: cfg.input,
					cost: cfg.cost,
					contextWindow: cfg.contextWindow,
					maxTokens: cfg.maxTokens,
				} as any,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any,
				{ apiKey: "glpat-test", maxTokens: 32 },
			);
		const mintCount = () => requests.filter((r) => r.path.endsWith("third_party_agents/direct_access")).length;

		await consume(stream());
		await consume(stream());
		assert.equal(mintCount(), 1, "second request should reuse the cached token");

		// A server expiry that lands in the past (minus the 60s safety margin)
		// must force a re-mint on the very next call.
		mod.invalidateDirectAccessToken();
		requests.length = 0;
		state.expiresAt = new Date(Date.now() + 30_000).toISOString();
		await consume(stream());
		await consume(stream());
		assert.equal(mintCount(), 2, "expired token should be re-minted");
		state.expiresAt = undefined;
	});

	it("re-mints when the instance host or token changes", async () => {
		requests.length = 0;
		state.expiresAt = undefined;
		mod.invalidateDirectAccessToken();
		await storeCredential({ type: "oauth", access: "glpat-test", instanceUrl: gateway, refresh: gateway, expires: Date.now() + 1e12 });
		const cfg = model("claude-sonnet-4-5-20250929");
		const mk = (apiKey: string) =>
			mod.streamGitLabDuo(
				{
					id: cfg.id,
					name: cfg.name,
					api: "gitlab-duo-api" as any,
					provider: "gitlab-duo",
					baseUrl: cfg.baseUrl,
					reasoning: false,
					input: cfg.input,
					cost: cfg.cost,
					contextWindow: cfg.contextWindow,
					maxTokens: cfg.maxTokens,
				} as any,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any,
				{ apiKey, maxTokens: 32 },
			);
		await consume(mk("glpat-test"));
		await consume(mk("glpat-other"));
		assert.equal(
			requests.filter((r) => r.path.endsWith("third_party_agents/direct_access")).length,
			2,
			"a different access token must not reuse the cache",
		);
	});

	it("streams an OpenAI-backed model through the gateway proxy", async () => {
		requests.length = 0;
		state.tokenSerial = 0;
		state.expiresAt = undefined;
		mod.invalidateDirectAccessToken();
		const cfg = model("gpt-5.1-2025-11-13");
		const events = await consume(
			mod.streamGitLabDuo(
				{
					id: cfg.id,
					name: cfg.name,
					api: "gitlab-duo-api" as any,
					provider: "gitlab-duo",
					baseUrl: cfg.baseUrl,
					reasoning: cfg.reasoning,
					input: cfg.input,
					cost: cfg.cost,
					contextWindow: cfg.contextWindow,
					maxTokens: cfg.maxTokens,
				} as any,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any,
				{ apiKey: "glpat-test", maxTokens: 32 },
			),
		);
		const proxyRequest = requests.find((r) => r.path.startsWith("/ai/v1/proxy/openai/"));
		assert.ok(proxyRequest, "expected an OpenAI proxy request");
		assert.equal(proxyRequest.path, "/ai/v1/proxy/openai/v1/responses");
		assert.equal(proxyRequest.headers.authorization, "Bearer gateway-token-1");
		const error = events.find((event) => event.type === "error");
		assert.equal(error, undefined, error?.error?.errorMessage);
	});

	it("reports entitlement failures with an actionable message", async () => {
		await storeCredential({ type: "oauth", access: "glpat-forbidden", instanceUrl: gateway, refresh: gateway, expires: Date.now() + 1e12 });
		state.directAccessStatus = 403;
		try {
			const cfg = model("claude-sonnet-4-5-20250929");
			const events = await consume(
				mod.streamGitLabDuo(
					{
						id: cfg.id,
						name: cfg.name,
						api: "gitlab-duo-api" as any,
						provider: "gitlab-duo",
						baseUrl: cfg.baseUrl,
						reasoning: false,
						input: cfg.input,
						cost: cfg.cost,
						contextWindow: cfg.contextWindow,
						maxTokens: cfg.maxTokens,
					} as any,
					{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any,
					{ apiKey: "glpat-forbidden", maxTokens: 32 },
				),
			);
			const error = events.find((event) => event.type === "error");
			assert.ok(error, "expected an error event");
			assert.match(error.error.errorMessage, /Duo access denied \(403\)/);
			assert.match(error.error.errorMessage, /Default group/);
		} finally {
			state.directAccessStatus = 0;
		}
	});

	it("never sends Duo Workflow headers to the proxy", async () => {
		requests.length = 0;
		mod.invalidateDirectAccessToken();
		state.expiresAt = undefined;
		await storeCredential({ type: "oauth", access: "glpat-test", instanceUrl: gateway, refresh: gateway, expires: Date.now() + 1e12 });
		process.env.GITLAB_PROJECT_ID = "group/project";
		process.env.GITLAB_DUO_PROJECT_CONTEXT = "1";
		try {
			const cfg = model("claude-sonnet-4-5-20250929");
			await consume(
				mod.streamGitLabDuo(
					{
						id: cfg.id,
						name: cfg.name,
						api: "gitlab-duo-api" as any,
						provider: "gitlab-duo",
						baseUrl: cfg.baseUrl,
						reasoning: false,
						input: cfg.input,
						cost: cfg.cost,
						contextWindow: cfg.contextWindow,
						maxTokens: cfg.maxTokens,
					} as any,
					{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any,
					{ apiKey: "glpat-test", maxTokens: 32 },
				),
			);
			const probe = requests.find((r) => r.path.endsWith("duo_workflows/direct_access"));
			assert.ok(probe, "opt-in probe should run");
			assert.match(probe.url, /project_id=group%2Fproject/);
			const proxyRequest = requests.find((r) => r.path.startsWith("/ai/v1/proxy/anthropic/"));
			assert.equal(proxyRequest?.headers["x-gitlab-unit-primitive"], "ai_gateway_model_provider_proxy");
		} finally {
			delete process.env.GITLAB_PROJECT_ID;
			delete process.env.GITLAB_DUO_PROJECT_CONTEXT;
		}
	});

	it("surfaces an aborted request as an error event", async () => {
		mod.invalidateDirectAccessToken();
		state.expiresAt = undefined;
		await storeCredential({ type: "oauth", access: "glpat-test", instanceUrl: gateway, refresh: gateway, expires: Date.now() + 1e12 });
		const controller = new AbortController();
		controller.abort();
		const cfg = model("claude-sonnet-4-5-20250929");
		const events = await consume(
			mod.streamGitLabDuo(
				{
					id: cfg.id,
					name: cfg.name,
					api: "gitlab-duo-api" as any,
					provider: "gitlab-duo",
					baseUrl: cfg.baseUrl,
					reasoning: false,
					input: cfg.input,
					cost: cfg.cost,
					contextWindow: cfg.contextWindow,
					maxTokens: cfg.maxTokens,
				} as any,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any,
				{ apiKey: "glpat-test", maxTokens: 32, signal: controller.signal },
			),
		);
		const error = events.find((event) => event.type === "error");
		assert.ok(error, "expected an error event for an aborted request");
		assert.match(error.error.errorMessage, /abort/i);
	});

	it("fails without a token", async () => {
		const cfg = model("claude-sonnet-4-5-20250929");
		const events = await consume(
			mod.streamGitLabDuo(
				{
					id: cfg.id,
					name: cfg.name,
					api: "gitlab-duo-api" as any,
					provider: "gitlab-duo",
					baseUrl: cfg.baseUrl,
					reasoning: false,
					input: cfg.input,
					cost: cfg.cost,
					contextWindow: cfg.contextWindow,
					maxTokens: cfg.maxTokens,
				} as any,
				{ messages: [] } as any,
				{ maxTokens: 32 },
			),
		);
		const error = events.find((event) => event.type === "error");
		assert.ok(error);
		assert.match(error.error.errorMessage, /No GitLab access token/);
	});
});

describe("model discovery", () => {
	afterEach(() => {
		state.anthropicModels = undefined;
		state.openaiModels = undefined;
		state.modelsStatus = 0;
		mod.resetModelCatalog();
	});

	async function refresh() {
		return mod.refreshDuoModels({
			credential: {
				type: "oauth",
				access: "glpat-test",
				instanceUrl: gateway,
				refresh: gateway,
				expires: Date.now() + 1e12,
			},
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async () => true,
		} as any);
	}

	it("asks both proxies for their model list with the gateway token", async () => {
		state.anthropicModels = [{ id: "claude-opus-9-20260301", display_name: "Claude Opus 9" }, "claude-sonnet-4-5-20250929"];
		state.openaiModels = ["gpt-6.1-sol-2026-01-15", "text-embedding-3-large"];
		requests.length = 0;
		state.tokenSerial = 0;
		state.expiresAt = undefined;
		mod.invalidateDirectAccessToken();

		const models = await mod.discoverModels("glpat-test");

		assert.deepEqual(
			models.map((entry) => entry.id),
			["claude-opus-9-20260301", "claude-sonnet-4-5-20250929", "gpt-6.1-sol-2026-01-15"],
			"embedding models must not appear as chat models",
		);

		const listRequest = requests.find((request) => request.path === "/ai/v1/proxy/anthropic/v1/models");
		assert.ok(listRequest, "expected the Anthropic model list to be requested");
		assert.equal(listRequest.headers.authorization, "Bearer gateway-token-1");
		assert.equal(listRequest.headers["x-gitlab-unit-primitive"], "ai_gateway_model_provider_proxy");
		assert.ok(requests.some((request) => request.path === "/ai/v1/proxy/openai/v1/models"));

		const [opus, , sol] = models as [typeof models[number], typeof models[number], typeof models[number]];
		assert.equal(opus.backend, "anthropic");
		assert.equal(opus.name, "Claude Opus 9", "the proxy display name wins");
		assert.equal(opus.baseUrl, `${gateway}/ai/v1/proxy/anthropic/`);
		assert.equal(opus.contextWindow, 200000);
		assert.equal(opus.maxTokens, 32000);
		assert.equal(opus.thinkingLevelMap?.xhigh, "max");
		assert.equal(opus.reasoning, true);
		assert.equal(sol.backend, "openai");
		assert.equal(sol.baseUrl, `${gateway}/ai/v1/proxy/openai/v1`);
		assert.equal(sol.name, "GPT 6.1 Sol", "a dated id gets a readable name");
	});

	it("never empties the catalog when discovery fails", async () => {
		state.modelsStatus = 500;
		mod.invalidateDirectAccessToken();

		await assert.rejects(mod.discoverModels("glpat-test"), /No models discovered .* answered 500/);
		const models = await refresh();

		assert.equal(models.length, mod.MODELS.length, "the vendored fallback survives a failed discovery");
		assert.match(mod.discoveryError() ?? "", /answered 500/);
	});

	it("keeps the previous catalog when a later discovery fails", async () => {
		state.anthropicModels = ["claude-haiku-9-20270101"];
		await refresh();
		assert.deepEqual(mod.modelCatalog().map((entry) => entry.id), ["claude-haiku-9-20270101"]);

		state.modelsStatus = 503;
		mod.invalidateDirectAccessToken();
		await refresh();
		assert.deepEqual(
			mod.modelCatalog().map((entry) => entry.id),
			["claude-haiku-9-20270101"],
			"a failed refresh must not drop the working catalog",
		);
	});

	it("skips the network when pi runs offline", async () => {
		requests.length = 0;
		const models = await mod.refreshDuoModels({
			credential: { type: "oauth", access: "glpat-test", refresh: gateway, expires: Date.now() + 1e12 },
			allowNetwork: false,
			signal: new AbortController().signal,
			publish: async () => true,
		} as any);
		assert.equal(models.length, mod.MODELS.length);
		assert.equal(requests.length, 0, "allowNetwork: false must not mint a token or hit the gateway");
	});

	it("streams a discovered model through the proxy its family belongs to", async () => {
		state.anthropicModels = ["claude-haiku-9-20270101"];
		await refresh();
		requests.length = 0;
		state.tokenSerial = 0;
		mod.invalidateDirectAccessToken();

		const cfg = mod.modelConfig("claude-haiku-9-20270101");
		assert.equal(cfg.backend, "anthropic");
		assert.equal(cfg.maxTokens, 8192, "family metadata applies to a model the fallback list never knew");

		const events = await consume(
			mod.streamGitLabDuo(
				{
					id: cfg.id,
					name: cfg.name,
					api: "gitlab-duo-api" as any,
					provider: "gitlab-duo",
					baseUrl: cfg.baseUrl,
					reasoning: cfg.reasoning,
					input: cfg.input,
					cost: cfg.cost,
					contextWindow: cfg.contextWindow,
					maxTokens: cfg.maxTokens,
				} as any,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any,
				{ apiKey: "glpat-test", maxTokens: 32 },
			),
		);

		const error = events.find((event) => event.type === "error");
		assert.equal(error, undefined, error?.error?.errorMessage);
		assert.ok(
			requests.some((request) => request.path === "/ai/v1/proxy/anthropic/v1/messages"),
			"a discovered Claude model must use the Anthropic proxy",
		);
	});

	it("infers an OpenAI backend for an unknown id", () => {
		mod.resetModelCatalog();
		const cfg = mod.modelConfig("gpt-7-unreleased");
		assert.equal(cfg.backend, "openai");
		assert.equal(cfg.baseUrl, `${gateway}/ai/v1/proxy/openai/v1`);
	});
});

describe("gitRemoteProjectPath", () => {
	async function repoWithRemote(remote: string): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "pi-duo-repo-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
		return dir;
	}

	it("prefers GITLAB_PROJECT_ID", () => {
		process.env.GITLAB_PROJECT_ID = "group/sub/project";
		try {
			assert.equal(mod.gitRemoteProjectPath(), "group/sub/project");
		} finally {
			delete process.env.GITLAB_PROJECT_ID;
		}
	});

	it("parses scp-style and https remotes from the cwd", async () => {
		const cwd = process.cwd();
		try {
			process.chdir(await repoWithRemote("git@gitlab.example.com:group/proj.git"));
			assert.equal(mod.gitRemoteProjectPath(), "group/proj");
			process.chdir(await repoWithRemote("https://gitlab.example.com/group/proj.git"));
			assert.equal(mod.gitRemoteProjectPath(), "group/proj");
		} finally {
			process.chdir(cwd);
		}
	});

	it("returns undefined outside a repository", async () => {
		const cwd = process.cwd();
		const dir = await mkdtemp(join(tmpdir(), "pi-duo-norepo-"));
		try {
			process.chdir(dir);
			assert.equal(mod.gitRemoteProjectPath(), undefined);
		} finally {
			process.chdir(cwd);
		}
	});
});
