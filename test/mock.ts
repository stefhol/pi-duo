/**
 * A local HTTP server standing in for both a GitLab instance (`/api/v4/...`)
 * and the AI gateway (`/ai/v1/proxy/...`). Used by the offline tests.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface Recorded {
	method: string;
	url: string;
	path: string;
	headers: IncomingMessage["headers"];
	body: string;
}

export interface MockState {
	/** Status for GET /api/v4/user. */
	userStatus: number;
	/** Status returned by the token endpoint while > 0. */
	directAccessStatus: number;
	/** `expires_at` value echoed by the token endpoint. */
	expiresAt?: string;
	/** Increments with every minted gateway token. */
	tokenSerial: number;
	/** Ids listed by the Anthropic proxy; unset = 404 (no discovery). */
	anthropicModels?: Array<string | { id: string; display_name?: string }>;
	/** Ids listed by the OpenAI proxy; unset = 404 (no discovery). */
	openaiModels?: string[];
	/** Status for both model-list endpoints while > 0. */
	modelsStatus: number;
}

export interface MockGitLab {
	baseUrl: string;
	requests: Recorded[];
	state: MockState;
	close(): Promise<void>;
}

function sse(res: ServerResponse, events: Array<[string, unknown]>) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	res.end();
}

function anthropicStream(res: ServerResponse) {
	sse(res, [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5-20250929",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 7, output_tokens: 0 },
				},
			},
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello from the fake gateway" },
			},
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 6 },
			},
		],
		["message_stop", { type: "message_stop" }],
	]);
}

function openAIStream(res: ServerResponse) {
	sse(res, [
		[
			"response.created",
			{
				type: "response.created",
				response: { id: "resp_test", object: "response", status: "in_progress", output: [] },
			},
		],
		[
			"response.output_item.added",
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] },
			},
		],
		[
			"response.content_part.added",
			{
				type: "response.content_part.added",
				item_id: "msg_test",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			},
		],
		[
			"response.output_text.delta",
			{
				type: "response.output_text.delta",
				item_id: "msg_test",
				output_index: 0,
				content_index: 0,
				delta: "Hello",
			},
		],
		[
			"response.output_text.done",
			{
				type: "response.output_text.done",
				item_id: "msg_test",
				output_index: 0,
				content_index: 0,
				text: "Hello",
			},
		],
		[
			"response.completed",
			{
				type: "response.completed",
				response: {
					id: "resp_test",
					object: "response",
					status: "completed",
					output: [],
					usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
				},
			},
		],
	]);
}

export async function startMockGitLab(): Promise<MockGitLab> {
	const requests: Recorded[] = [];
	const state: MockState = { userStatus: 200, directAccessStatus: 0, tokenSerial: 0, modelsStatus: 0 };

	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const url = req.url ?? "";
			const path = url.split("?")[0] ?? "";
			requests.push({ method: req.method ?? "", url, path, headers: req.headers, body });

			if (path === "/api/v4/user") {
				if (state.userStatus !== 200) {
					res.writeHead(state.userStatus).end("nope");
					return;
				}
				res
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify({ username: "duo-user" }));
				return;
			}

			if (path === "/api/v4/ai/third_party_agents/direct_access") {
				if (state.directAccessStatus > 0) {
					res.writeHead(state.directAccessStatus).end("denied");
					return;
				}
				state.tokenSerial++;
				res
					.writeHead(201, { "content-type": "application/json" })
					.end(
						JSON.stringify({
							token: `gateway-token-${state.tokenSerial}`,
							headers: {
								"x-gitlab-unit-primitive": "ai_gateway_model_provider_proxy",
								"x-gitlab-realm": "self-managed",
							},
							...(state.expiresAt ? { expires_at: state.expiresAt } : {}),
						}),
					);
				return;
			}

			if (path === "/api/v4/ai/duo_workflows/direct_access") {
				res
					.writeHead(201, { "content-type": "application/json" })
					.end(
						JSON.stringify({
							duo_workflow_service: { headers: { "x-gitlab-unit-primitive": "duo_agent_platform" } },
						}),
					);
				return;
			}

			if (path === "/ai/v1/proxy/anthropic/v1/models" || path === "/ai/v1/proxy/openai/v1/models") {
				if (state.modelsStatus > 0) {
					res.writeHead(state.modelsStatus).end("no model list");
					return;
				}
				const anthropic = path.includes("/anthropic/");
				const ids = anthropic ? state.anthropicModels : state.openaiModels;
				if (!ids) {
					res.writeHead(404).end("no model list");
					return;
				}
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						data: ids.map((entry) => {
							const id = typeof entry === "string" ? entry : entry.id;
							const name = typeof entry === "string" ? undefined : entry.display_name;
							return anthropic
								? { type: "model", id, ...(name ? { display_name: name } : {}) }
								: { object: "model", id };
						}),
					}),
				);
				return;
			}

			if (path.startsWith("/ai/v1/proxy/anthropic/")) {
				anthropicStream(res);
				return;
			}

			if (path.startsWith("/ai/v1/proxy/openai/")) {
				openAIStream(res);
				return;
			}

			res.writeHead(404).end("unknown path");
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address !== "object") throw new Error("mock server did not bind");

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		state,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
