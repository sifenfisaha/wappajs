# Changelog

All notable changes to this project are documented here. The packages are versioned
together: every release publishes all seven at the same version, because
`create-wappa-agent` pins the dependencies it scaffolds to its own version.

## 0.2.0 (2026-09-22)

### Added

- `@wappajs/core`: `Agent` takes `knowledge`, the half of the system prompt that does
  not change from one message to the next. It is sent before `instructions`, and the
  provider receives the split as `GenerateRequest.systemParts` so it can cache the
  stable part.
- `@wappajs/core`: `GenerateResult.providerData` and `ChatMessage.providerData`, an
  opaque field a provider uses to replay an assistant turn exactly as its API produced
  it. The Agent copies it onto the message it appends and session stores persist it.
  `ScriptedProvider` passes it through.
- `@wappajs/anthropic`: prompt caching for `knowledge` (a cache breakpoint after the
  stable system block), `effort` (`output_config.effort`), `thinking` (passed
  through), and `extraParams` for Messages API fields the provider does not model.
- `@wappajs/twilio` and `@wappajs/cloud-api`: `handleFetch(request)`, a WHATWG
  `Request`/`Response` handler for Bun, Deno, Cloudflare Workers, Hono, Next.js route
  handlers and any other fetch-style host. Same semantics as `handleRequest`; path
  routing belongs to the host.
- `scripts/version.mjs` moves the examples' ranges along with the packages.

### Fixed

- `@wappajs/anthropic`: the thinking blocks of a tool-calling turn are now kept (as
  `providerData`) and replayed unchanged, as the Messages API requires on the
  adaptive-thinking models, the default `claude-sonnet-5` among them. Before, the second
  call of a tool loop could be rejected because the assistant turn came back without its
  thinking block. Replayed blocks are rebuilt with request fields only, since the API
  rejects the response-only fields (`citations`, `caller`).
- `@wappajs/anthropic`: a turn the model refuses is logged at warn level with its
  `stop_details` instead of passing silently.
- `@wappajs/twilio` README: the sender option is `whatsappNumber`, not `from`.

## 0.1.1 (2026-09-16)

First public release. All packages are published under the `@wappajs` scope.

### Added

- `@wappajs/core`: transport agnostic runtime. `Bot` (per chat queues, middleware chain,
  graceful shutdown), `Agent` (tool call loop, history window, error rollback, `maxTurns`
  cap), `defineTool` with zod inferred and validated arguments, session stores (in memory
  and file backed), and the `Transport` and `Provider` interfaces.
- `@wappajs/core/testing`: `MockTransport` and `ScriptedProvider` for testing a whole bot
  offline, with no WhatsApp connection and no LLM key.
- `@wappajs/baileys`: personal number transport with QR login and persistent auth state.
- `@wappajs/cloud-api`: official Meta WhatsApp Cloud API transport. Webhook verification
  handshake, `X-Hub-Signature-256` validation, and Graph API sending, with no Meta SDK
  dependency.
- `@wappajs/twilio`: Twilio WhatsApp (BSP) transport. Form encoded webhook parsing,
  `X-Twilio-Signature` validation, and the Messages REST API, with no Twilio SDK
  dependency.
- `@wappajs/anthropic`: Claude provider, default model `claude-sonnet-5`.
- `@wappajs/openai`: OpenAI provider, default model `gpt-5`, and any OpenAI compatible
  server through `baseURL` (Ollama, vLLM, OpenRouter, LM Studio).
- `create-wappa-agent`: project scaffolder, interactive or fully flag driven.

### Notes

- Node 20 or newer. The packages are ESM only, so your project needs `"type": "module"`.
- An earlier partial release published `wappa-baileys`, `wappa-cloud-api` and
  `wappa-anthropic` as unscoped packages at 0.1.0. Those versions are broken, since they
  depend on a `wappa` core package that was never published. They are deprecated in favor
  of the `@wappajs` packages. Version 0.1.0 was skipped for the scoped release because npm
  does not allow reusing a version number.
