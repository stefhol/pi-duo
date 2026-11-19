/**
 * GitLab Duo Provider Extension (self-managed friendly)
 *
 * Provides access to GitLab Duo AI models (Claude and GPT) through GitLab's AI Gateway.
 * Delegates to pi-ai's built-in Anthropic and OpenAI streaming implementations.
 *
 * Based on pi 1.5.2 `examples/extensions/custom-provider-gitlab-duo/index.ts`.
 * Differences from the bundled example:
 *   - `/login` asks for the instance URL and a personal access token instead of
 *     running the gitlab.com OAuth flow, so any GitLab instance works.
 *   - The instance URL is per credential (stored in auth.json), with
 *     GITLAB_HOST / GITLAB_URL as the headless fallback.
 *   - The AI gateway host is configurable (GITLAB_AI_GATEWAY_URL) for
 *     Duo Self-Hosted / Local AI Gateway deployments.
 *   - The direct-access token cache is keyed by host + token and honours
 *     the server-provided `expires_at`.
 *
 * Usage:
 *   pi        # /login -> GitLab Duo -> instance URL, PAT
 *   # or: GITLAB_HOST=https://gitlab.example.com GITLAB_TOKEN=glpat-... pi
 */

import { execFileSync } from "node:child_process";
import {
	type Api,
	type AssistantMessageEventStream,
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	openAIResponsesApi,
	type SimpleStreamOptions,
	type ThinkingLevelMap,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, readStoredCredential } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_ID = "gitlab-duo";
const DEFAULT_HOST = "https://gitlab.com";
const DIRECT_ACCESS_TTL = 25 * 60 * 1000;
/** A PAT does not expire, so store a far-future expiry and never refresh. */
const PAT_EXPIRY = 10 * 365 * 24 * 3600 * 1000;

const AI_GATEWAY_URL = (process.env.GITLAB_AI_GATEWAY_URL ?? "https://cloud.gitlab.com").replace(/\/+$/, "");
const ANTHROPIC_PROXY_URL = `${AI_GATEWAY_URL}/ai/v1/proxy/anthropic/`;
const OPENAI_PROXY_URL = `${AI_GATEWAY_URL}/ai/v1/proxy/openai/v1`;

/**
 * Accept "gitlab.example.com", "http://gitlab.example.com/" and friends;
 * always return an origin without a trailing slash.
 */
export function normalizeHost(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	return withScheme.replace(/\/+$/, "");
}

// =============================================================================
// Instance URL resolution
// =============================================================================

interface StoredDuoCredential {
	instanceUrl?: string;
	refresh?: string;
}

/**
 * Instance URL: stored credential first, then env, then gitlab.com.
 * `refresh` holds the same URL as a fallback in case extra credential keys are
 * ever stripped by a future auth store.
 */
export function gitlabHost(): string {
	let stored: string | undefined;
	try {
		const credential = readStoredCredential(PROVIDER_ID) as StoredDuoCredential | undefined;
		if (typeof credential?.instanceUrl === "string" && credential.instanceUrl) {
			stored = credential.instanceUrl;
		} else if (typeof credential?.refresh === "string" && /^https?:\/\//i.test(credential.refresh)) {
			stored = credential.refresh;
		}
	} catch {
		// Unreadable auth.json must not break env-based use.
	}
	return normalizeHost(stored ?? process.env.GITLAB_HOST ?? process.env.GITLAB_URL ?? DEFAULT_HOST);
}

// =============================================================================
// Models - exported for use by tests
// =============================================================================

type Backend = "anthropic" | "openai";

interface GitLabModel {
	id: string;
	name: string;
	backend: Backend;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export const MODELS: GitLabModel[] = [
	// Anthropic
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	{
		id: "claude-opus-4-5-20251101",
		name: "Claude Opus 4.5",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	},
	{
		id: "claude-sonnet-4-5-20250929",
		name: "Claude Sonnet 4.5",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 16384,
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	// OpenAI (all use Responses API)
	{
		id: "gpt-5.5-2026-04-23",
		name: "GPT-5.5",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.1-2025-11-13",
		name: "GPT-5.1",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5-mini-2025-08-07",
		name: "GPT-5 Mini",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5-codex",
		name: "GPT-5 Codex",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
];

const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

// =============================================================================
// Project context (diagnostics / parity only)
// =============================================================================

/**
 * Project path from GITLAB_PROJECT_ID, else the git remote of the cwd.
 * Only used for the advisory probe below: the token endpoint that actually
 * mints the proxy token takes no project input.
 */
export function gitRemoteProjectPath(): string | undefined {
	if (process.env.GITLAB_PROJECT_ID) return process.env.GITLAB_PROJECT_ID;
	try {
		const raw = execFileSync("git", ["remote", "get-url", "origin"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.replace(/\.git$/, "");
		const scp = raw.match(/^[^@/]+@[^:]+:(.+)$/); // git@host:group/proj
		if (scp) return scp[1];
		return new URL(raw).pathname.replace(/^\//, ""); // https://host/group/proj
	} catch {
		return undefined;
	}
}

/**
 * Advisory, opt-in (GITLAB_DUO_PROJECT_CONTEXT=1): ask the Duo Agent Platform
 * endpoint what headers it would use for the current project. Never fatal and
 * never a token path — Duo Workflows headers must not be sent to the
 * model-provider proxy, so they are merged *under* the proxy headers.
 */
async function resolveProjectContext(
	token: string,
	signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
	if (process.env.GITLAB_DUO_PROJECT_CONTEXT !== "1") return undefined;
	const project = gitRemoteProjectPath();
	if (!project) return undefined;
	try {
		const res = await fetch(
			`${gitlabHost()}/api/v4/ai/duo_workflows/direct_access?project_id=${encodeURIComponent(project)}`,
			{ method: "POST", headers: { Authorization: `Bearer ${token}` }, signal },
		);
		if (!res.ok) return undefined;
		const data = (await res.json()) as {
			duo_workflow_service?: { headers?: Record<string, string> };
		};
		return data.duo_workflow_service?.headers;
	} catch {
		return undefined; // diagnostics only
	}
}

// =============================================================================
// Direct Access Token Cache
// =============================================================================

interface DirectAccessToken {
	token: string;
	headers: Record<string, string>;
	expiresAt: number;
}

let cachedDirectAccess: DirectAccessToken | null = null;
/** Cache identity: host + access token, so a re-login or host change re-mints. */
let cachedDirectAccessKey: string | null = null;

/** Drop the cached gateway token (call after login/logout or on host change). */
export function invalidateDirectAccessToken() {
	cachedDirectAccess = null;
	cachedDirectAccessKey = null;
}

function describeTokenFailure(status: number, body: string): string {
	if (status === 401) {
		return `GitLab rejected the stored access token (401). Run /login gitlab-duo again. Details: ${body}`;
	}
	if (status === 403) {
		return `GitLab Duo access denied (403). Ensure Duo is enabled for your account and that Preferences → AI assistance → GitLab Duo has a Default group with Agent Platform enabled. Details: ${body}`;
	}
	if (status === 402) {
		return `GitLab Duo is out of credits or the instance proxy allowlist blocks this request (402). Ask your administrator. Details: ${body}`;
	}
	if (status === 404) {
		return `GitLab Duo endpoint not found on ${gitlabHost()} (404). Check the instance version and URL.`;
	}
	return `Failed to get GitLab Duo direct access token: ${status} ${body}`;
}

async function getDirectAccessToken(
	gitlabAccessToken: string,
	signal?: AbortSignal,
): Promise<DirectAccessToken> {
	const now = Date.now();
	const host = gitlabHost();
	const cacheKey = `${host}|${gitlabAccessToken}`;
	if (cachedDirectAccess && cachedDirectAccessKey === cacheKey && cachedDirectAccess.expiresAt > now) {
		return cachedDirectAccess;
	}

	const projectContextHeaders = await resolveProjectContext(gitlabAccessToken, signal);

	const response = await fetch(`${host}/api/v4/ai/third_party_agents/direct_access`, {
		method: "POST",
		headers: { Authorization: `Bearer ${gitlabAccessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }),
		signal,
	});

	if (!response.ok) {
		throw new Error(describeTokenFailure(response.status, await response.text()));
	}

	const data = (await response.json()) as {
		token: string;
		headers: Record<string, string>;
		expires_at?: string;
	};
	// directAccess.headers MUST win: they carry x-gitlab-unit-primitive: ai_gateway_model_provider_proxy.
	// DWS headers carry duo_agent_platform; sending those would make the gateway demand the wrong scope.
	const headers = { ...projectContextHeaders, ...data.headers };
	const parsed = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
	const expiresAt = Number.isFinite(parsed) ? Math.min(parsed - 60_000, now + DIRECT_ACCESS_TTL) : now + DIRECT_ACCESS_TTL;
	cachedDirectAccess = { token: data.token, headers, expiresAt };
	cachedDirectAccessKey = cacheKey;
	return cachedDirectAccess;
}

// =============================================================================
// Login (instance URL + personal access token)
// =============================================================================

export async function loginGitLabPat(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	// 1. Instance URL
	const host = normalizeHost(
		(await callbacks.onPrompt({
			message: "GitLab instance URL",
			placeholder: "https://gitlab.example.com",
		})) ||
			process.env.GITLAB_HOST ||
			DEFAULT_HOST,
	);
	if (!host || !/^https?:\/\/[^/]+/i.test(host)) {
		throw new Error(`"${host}" is not a usable GitLab URL. Expected something like https://gitlab.example.com`);
	}

	// 2. Personal access token
	const pat = (
		await callbacks.onPrompt({
			message: `Personal access token for ${host} (scope: api)`,
			placeholder: "glpat-…",
		})
	).trim();
	if (!pat) throw new Error("No personal access token entered. Nothing was stored.");

	// 3. Validate before storing anything
	callbacks.onProgress?.(`Checking ${host}/api/v4/user …`);
	let userRes: Response;
	try {
		userRes = await fetch(`${host}/api/v4/user`, {
			headers: { Authorization: `Bearer ${pat}` },
			signal: callbacks.signal,
		});
	} catch (error) {
		if (callbacks.signal?.aborted) throw new Error("Login cancelled");
		throw new Error(
			`Could not reach GitLab at ${host}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!userRes.ok) {
		throw new Error(
			userRes.status === 401
				? `GitLab rejected the token for ${host} (401). Check the URL and the PAT's api scope.`
				: `GitLab at ${host} answered HTTP ${userRes.status}.`,
		);
	}
	const user = (await userRes.json()) as { username?: string };
	callbacks.onProgress?.(`Authenticated as ${user.username ?? "unknown user"} on ${host}`);

	// 4. Optional entitlement pre-check: mints a gateway token and writes an
	// audit event per login, so it stays opt-in.
	if (process.env.GITLAB_DUO_ENTITLEMENT_PRECHECK === "1") {
		callbacks.onProgress?.("Checking GitLab Duo entitlement …");
		const res = await fetch(`${host}/api/v4/ai/third_party_agents/direct_access`, {
			method: "POST",
			headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
			body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }),
			signal: callbacks.signal,
		});
		if (!res.ok) {
			throw new Error(describeTokenFailure(res.status, await res.text()));
		}
	}

	invalidateDirectAccessToken();
	return {
		access: pat,
		refresh: host, // guaranteed persisted; a PAT has nothing to refresh
		expires: Date.now() + PAT_EXPIRY,
		instanceUrl: host,
	};
}

/** A PAT cannot be refreshed; keep the credential as is. */
async function passthroughRefresh(
	credentials: OAuthCredentials,
	_signal: AbortSignal,
): Promise<OAuthCredentials> {
	return { ...credentials, expires: Date.now() + PAT_EXPIRY };
}

// =============================================================================
// Stream Function
// =============================================================================

export function streamGitLabDuo(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const gitlabAccessToken = options?.apiKey;
			if (!gitlabAccessToken) {
				throw new Error(
					"No GitLab access token. Run /login gitlab-duo, or set GITLAB_HOST and GITLAB_TOKEN.",
				);
			}

			const cfg = MODEL_MAP.get(model.id);
			if (!cfg) throw new Error(`Unknown model: ${model.id}`);

			const directAccess = await getDirectAccessToken(gitlabAccessToken, options?.signal);
			const modelWithBaseUrl = { ...model, baseUrl: cfg.baseUrl };
			const headers = { ...directAccess.headers, Authorization: `Bearer ${directAccess.token}` };
			const streamOptions = { ...options, apiKey: "gitlab-duo", headers };

			const innerStream =
				cfg.backend === "anthropic"
					? anthropicMessagesApi().streamSimple(
							{
								...(modelWithBaseUrl as Model<"anthropic-messages">),
								compat: {
									...(modelWithBaseUrl as Model<"anthropic-messages">).compat,
									forceAdaptiveThinking: true,
								},
							},
							context,
							streamOptions,
						)
					: openAIResponsesApi().streamSimple(
							modelWithBaseUrl as Model<"openai-responses">,
							context,
							streamOptions,
						);

			for await (const event of innerStream) stream.push(event);
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		name: "GitLab Duo",
		baseUrl: AI_GATEWAY_URL,
		// Env fallback for CI/headless use, registered only when the variable exists:
		// a configured-but-unresolvable key makes pi throw instead of reporting the
		// provider as unconfigured.
		...(process.env.GITLAB_TOKEN ? { apiKey: "$GITLAB_TOKEN" } : {}),
		api: "gitlab-duo-api",
		models: MODELS.map(({ id, name, reasoning, thinkingLevelMap, input, cost, contextWindow, maxTokens }) => ({
			id,
			name,
			reasoning,
			thinkingLevelMap,
			input,
			cost,
			contextWindow,
			maxTokens,
		})),
		streamSimple: streamGitLabDuo,
		oauth: {
			name: "GitLab Duo (instance URL + token)",
			login: loginGitLabPat,
			refreshToken: passthroughRefresh,
			getApiKey: (cred) => cred.access,
		},
	});
}
