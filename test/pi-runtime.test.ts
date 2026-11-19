/**
 * Integration test against pi's own model runtime (1.5.2).
 *
 * This drives the same code path the TUI uses for `/login`: the extension is
 * registered through `ModelRuntime.registerProvider`, the provider's OAuth
 * adapter runs the login, the credential is persisted to auth.json, and auth
 * resolution then hands the PAT to the provider.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { startMockGitLab } from "./mock.ts";

const mock = await startMockGitLab();

let agentDir: string;
let mod: typeof import("../index.ts");
let runtime: import("@earendil-works/pi-coding-agent").ModelRuntime;

interface Prompt {
	type: string;
	message: string;
}

function interaction(answers: string[]) {
	const prompts: Prompt[] = [];
	const notes: Array<{ type: string; message?: string }> = [];
	let index = 0;
	return {
		prompts,
		notes,
		signal: new AbortController().signal,
		prompt: async (prompt: Prompt) => {
			prompts.push(prompt);
			const answer = answers[index++];
			assert.notEqual(answer, undefined, `unexpected prompt: ${prompt.message}`);
			return answer as string;
		},
		notify: (event: { type: string; message?: string }) => notes.push(event),
	};
}

async function authFile(): Promise<Record<string, any>> {
	return JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"));
}

/** Call the extension factory with the parts of pi's API it uses. */
function fakeExtension(registrations: Array<[string, any]>, commands: string[] = []): void {
	mod.default({
		registerProvider: (providerId: string, config: unknown) => registrations.push([providerId, config]),
		registerCommand: (name: string) => commands.push(name),
	} as never);
}

before(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-duo-runtime-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.GITLAB_AI_GATEWAY_URL = mock.baseUrl;
	delete process.env.GITLAB_HOST;
	delete process.env.GITLAB_URL;
	delete process.env.GITLAB_TOKEN;
	delete process.env.GITLAB_DUO_ENTITLEMENT_PRECHECK;

	mod = await import("../index.ts");
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });

	// Register the same way pi's extension API does.
	const registrations: Array<[string, any]> = [];
	fakeExtension(registrations);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0]?.[0], "gitlab-duo");
	runtime.registerProvider(registrations[0]![0], registrations[0]![1]);
});

after(async () => {
	await mock.close();
});

describe("provider registration", () => {
	it("registers the GitLab Duo models with pi", () => {
		const models = runtime.getModels("gitlab-duo");
		assert.equal(models.length, mod.MODELS.length);
		assert.ok(models.some((model) => model.id === "claude-sonnet-4-5-20250929"));
		assert.equal(runtime.getProvider("gitlab-duo")?.name, "GitLab Duo");
	});

	it("registers the /duo-models diagnostic command", () => {
		const commands: string[] = [];
		fakeExtension([], commands);
		assert.deepEqual(commands, ["duo-models"]);
	});

	it("registers the GITLAB_TOKEN fallback only when the variable is set", () => {
		const capture = () => {
			const registrations: Array<[string, any]> = [];
			fakeExtension(registrations);
			return registrations[0]![1];
		};
		assert.equal(capture().apiKey, undefined, "no key config, so pi reports the provider as unconfigured");
		process.env.GITLAB_TOKEN = "glpat-env";
		try {
			assert.equal(capture().apiKey, "$GITLAB_TOKEN");
		} finally {
			delete process.env.GITLAB_TOKEN;
		}
	});

	it("is not available before login or GITLAB_TOKEN", async () => {
		assert.deepEqual(await runtime.getAvailable("gitlab-duo"), []);
		assert.equal(await runtime.getAuth("gitlab-duo"), undefined);
	});
});

describe("/login flow", () => {
	it("prompts for the instance URL, then the PAT, and stores both", async () => {
		const ui = interaction([mock.baseUrl, "glpat-from-login"]);
		const credential = (await runtime.login("gitlab-duo", "oauth", ui as never)) as Record<string, any>;

		assert.equal(ui.prompts[0]?.message, "GitLab instance URL");
		assert.match(ui.prompts[1]?.message ?? "", /^Personal access token for http:\/\/127\.0\.0\.1:\d+ \(scope: api\)$/);
		assert.ok(ui.prompts.every((prompt) => prompt.type === "text"));
		assert.ok(
			ui.notes.some((note) => note.type === "progress" && note.message?.includes("duo-user")),
			"username should be reported as progress",
		);

		assert.equal(credential.type, "oauth");
		assert.equal(credential.access, "glpat-from-login");
		assert.equal(credential.instanceUrl, mock.baseUrl);
		assert.equal(credential.refresh, mock.baseUrl);

		const stored = (await authFile())["gitlab-duo"];
		assert.equal(stored.type, "oauth");
		assert.equal(stored.access, "glpat-from-login");
		assert.equal(stored.instanceUrl, mock.baseUrl, "instanceUrl must survive the credential round trip");

		// The URL prompt reached the mock instance, so the PAT went to the right host.
		assert.ok(mock.requests.some((request) => request.path === "/api/v4/user"));
	});

	it("makes the models available and resolves the PAT as the api key", async () => {
		const available = await runtime.getAvailable("gitlab-duo");
		assert.equal(available.length, mod.MODELS.length);

		const model = runtime.getModel("gitlab-duo", "claude-sonnet-4-5-20250929");
		assert.ok(model);
		const auth = await runtime.getAuth(model);
		assert.equal(auth?.auth.apiKey, "glpat-from-login");
	});

	it("uses the login URL, not the default gitlab.com", async () => {
		const model = runtime.getModel("gitlab-duo", "claude-sonnet-4-5-20250929");
		assert.ok(model);
		await runtime.getAuth(model);
		assert.equal(mod.gitlabHost(), mock.baseUrl);
	});

	it("stores nothing when the PAT is rejected", async () => {
		mock.state.userStatus = 401;
		try {
			const ui = interaction([mock.baseUrl, "glpat-bad"]);
			await assert.rejects(runtime.login("gitlab-duo", "oauth", ui as never), /401/);
		} finally {
			mock.state.userStatus = 200;
		}
		// The earlier credential is still the one in place (no half-written entry).
		assert.equal((await authFile())["gitlab-duo"].access, "glpat-from-login");
	});
});

describe("model refresh", () => {
	afterEach(async () => {
		mock.state.anthropicModels = undefined;
		mock.state.openaiModels = undefined;
		mod.resetModelCatalog();
		await runtime.refresh({ providers: ["gitlab-duo"], allowNetwork: false, force: true });
	});

	it("replaces the registered models with what the gateway proxies list", async () => {
		mock.state.anthropicModels = [{ id: "claude-opus-9-20260301", display_name: "Claude Opus 9" }];
		mock.state.openaiModels = ["gpt-6.1-sol-2026-01-15"];

		const result = await runtime.refresh({ providers: ["gitlab-duo"], allowNetwork: true, force: true });
		assert.equal(result.errors.size, 0, [...result.errors.values()].map((error) => error.message).join("; "));

		const models = runtime.getModels("gitlab-duo");
		assert.deepEqual(
			models.map((model) => model.id).sort(),
			["claude-opus-9-20260301", "gpt-6.1-sol-2026-01-15"],
			"the stored PAT must reach refreshModels and the discovery must replace the fallback list",
		);
		const sol = runtime.getModel("gitlab-duo", "gpt-6.1-sol-2026-01-15");
		assert.ok(sol);
		assert.equal(sol.name, "GPT 6.1 Sol");
	});

	it("does not call the gateway when the network is disallowed", async () => {
		mock.requests.length = 0;
		await runtime.refresh({ providers: ["gitlab-duo"], allowNetwork: false, force: true });
		assert.equal(
			mock.requests.filter((request) => request.path.includes("/models")).length,
			0,
			"an offline refresh must not hit the model-list endpoints",
		);
	});
});

describe("/logout", () => {
	it("removes the credential so the provider is unconfigured again", async () => {
		await runtime.logout("gitlab-duo");
		assert.equal((await authFile())["gitlab-duo"], undefined);
		assert.equal(await runtime.getAuth("gitlab-duo"), undefined);
		assert.deepEqual(await runtime.getAvailable("gitlab-duo"), []);
	});
});
