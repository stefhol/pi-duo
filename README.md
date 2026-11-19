# pi-gitlab-duo

GitLab Duo as a pi provider, for **self-managed GitLab too**.

`/login` asks for your instance URL and a personal access token, validates them, stores
them, and every request mints a short-lived gateway token against that instance. `/model`
then lists the models **your instance actually serves** — the extension asks both gateway
proxies for their model list instead of shipping a frozen catalog (see [Models](#models)).

Based on pi 1.5.2's `examples/extensions/custom-provider-gitlab-duo`, with the hardcoded
`gitlab.com` / `cloud.gitlab.com` hosts replaced by configuration, a PAT login instead of
the gitlab.com OAuth app, and model discovery instead of the example's vendored list.

## Install

```bash
node scripts/install.mjs          # symlink ~/.pi/agent/extensions/pi-gitlab-duo -> this repo
node scripts/install.mjs --copy   # or copy index.ts + package.json into that directory
```

Restart pi, or run `/reload`.

## Log in

```
/login            -> GitLab Duo
GitLab instance URL: https://gitlab.example.com
Personal access token for https://gitlab.example.com (scope: api): glpat-…
```

The token is checked against `GET /api/v4/user` before anything is stored. The credential
lands in `~/.pi/agent/auth.json` under `gitlab-duo`:

```json
{
  "gitlab-duo": {
    "type": "oauth",
    "access": "glpat-…",
    "instanceUrl": "https://gitlab.example.com",
    "refresh": "https://gitlab.example.com",
    "expires": 2077000000000
  }
}
```

`refresh` holds the same URL as a fallback in case `instanceUrl` ever gets stripped by a
future auth store. The PAT itself has no expiry, so `expires` is far in the future and
`refreshToken` is a no-op.

`/logout` removes the entry; requests then fail with a clear "No GitLab access token".

## Headless / CI

No login needed, environment variables are enough:

| Variable | Meaning | Default |
|---|---|---|
| `GITLAB_HOST` | Instance URL (also accepts `GITLAB_URL`) | `https://gitlab.com` |
| `GITLAB_TOKEN` | Personal access token, scope `api` | — |
| `GITLAB_AI_GATEWAY_URL` | AI gateway base URL (Duo Self-Hosted / Local AI Gateway) | `https://cloud.gitlab.com` |
| `GITLAB_PROJECT_ID` | Project path for the opt-in context probe | git remote of the cwd |
| `GITLAB_DUO_PROJECT_CONTEXT` | `1` enables the advisory Duo Workflow context probe | off |
| `GITLAB_DUO_ENTITLEMENT_PRECHECK` | `1` makes `/login` mint a gateway token too, so entitlement problems surface at login | off |

Precedence for the instance URL: stored credential → `GITLAB_HOST` / `GITLAB_URL` →
`https://gitlab.com`. A stored credential also beats `GITLAB_TOKEN` for the token itself.

`GITLAB_TOKEN` is registered as a provider API-key fallback only when the variable is
already set at startup (an unresolvable configured key would make pi report an error
instead of "not configured"). Everything else goes through the login flow.

## Models

The model list is **discovered from your instance**, not hardcoded. When pi refreshes its
model catalogs (startup, and each time `/model` opens), the extension calls
`refreshModels`, mints the short-lived direct-access token with your stored PAT, and asks
both gateway proxies what they serve:

```
GET ${GITLAB_AI_GATEWAY_URL}/ai/v1/proxy/anthropic/v1/models
GET ${GITLAB_AI_GATEWAY_URL}/ai/v1/proxy/openai/v1/models
```

Each proxy's ids become selectable models (`[gitlab-duo]` in `/model`), routed back to the
same proxy they came from. The names come from the proxy's `display_name` where present,
otherwise from the id. Non-chat OpenAI ids (embeddings, audio, images, …) are filtered
out. `refreshModels` never throws and never empties the list: a failed discovery — no PAT
yet, offline, self-hosted gateway without the endpoint — keeps the previous catalog, and
the vendored pi 1.5.2 list at the top of `index.ts` is the initial fallback.

Inspect at any time:

```
/duo-models            # models pi currently has for this provider
/duo-models refresh    # probe both proxies again
node smoke.ts --list   # same discovery outside pi (needs GITLAB_HOST + GITLAB_TOKEN)
```

Costs, context windows and max output tokens are **not** part of the proxy listing, so
`MODEL_FAMILIES` in `index.ts` covers them with per-family defaults (Opus/Sonnet/Haiku,
GPT/Codex/Mini). Those numbers are list prices and conservative limits: pi compacts a
little early rather than sending a request the model rejects. Add a family rule when a new
model needs better numbers.

## Self-managed prerequisites

Duo Agent Platform must be enabled for you:

1. `Preferences → AI assistance → GitLab Duo → Default group` = a top-level group with Duo
   enabled. On self-managed the candidates are your authorized top-level groups.
2. The instance must allow the third-party agents endpoint:
   `POST /api/v4/ai/third_party_agents/direct_access` should answer `201` with
   `{token, headers, expires_at}`.

Quick probe (mints a token and writes a `third_party_agent_token_created` audit event):

```bash
curl -sS -X POST -H "Authorization: Bearer $GITLAB_TOKEN" \
  "$GITLAB_HOST/api/v4/ai/third_party_agents/direct_access"
```

## Troubleshooting

| Symptom | Meaning |
|---|---|
| `401` at login | Wrong URL or the PAT lacks the `api` scope |
| `403` `Duo access denied` | Duo/Agent Platform not enabled for your resolved namespace, or direct code suggestions disabled — fix the Default group |
| `402` | Out of credits, or the instance proxy allowlist blocks the request — ask your admin |
| `404` | Endpoint missing: check the instance version and URL |
| `Could not reach GitLab at …` | Wrong URL, DNS, or TLS (self-signed CA is not trusted by Node) |

No client-side input can select the Duo namespace: entitlement is decided server-side from
your Default group at token mint time and again at the gateway.

## Development

```bash
npm install
npm run check     # tsc --noEmit
npm test          # offline: fake GitLab + fake AI gateway, no instance required
npm run smoke     # live request with your stored/login credentials
```

`test/local.test.ts` covers login validation, host precedence, token caching and expiry,
header precedence (proxy headers must win over Duo Workflow headers), both streaming
backends, model discovery (filtering, naming, metadata, failure fallback) and streaming a
model that only the discovery knows about. `test/pi-runtime.test.ts` drives pi's own
`ModelRuntime` — the same code path `/login` and `/model` take — and asserts the credential
round trip through `auth.json` plus the `refreshModels` hook publishing the discovered
catalog.

## Notes

- Pinned to pi / pi-ai **1.5.2**. On upgrade, `diff` `index.ts` against
  `examples/extensions/custom-provider-gitlab-duo/index.ts` and re-run `npm test` (the
  runtime test imports pi's own auth and provider types, so API drift shows up there).
- The direct-access token is cached per host + PAT and honours the server's `expires_at`
  (minus a 60 s margin, capped at 25 minutes).
- Nothing logs the PAT, the direct-access token, or the token endpoint body.
