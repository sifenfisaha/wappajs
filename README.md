# wappa

**The WhatsApp agent framework.**

[![npm](https://img.shields.io/npm/v/@wappajs/core)](https://www.npmjs.com/package/@wappajs/core)
[![node](https://img.shields.io/node/v/@wappajs/core)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@wappajs/core)](LICENSE)

`wappa` is a TypeScript framework for building WhatsApp agents: bots whose "brain" is an
LLM with tool-calling and whose "body" is a pluggable WhatsApp transport. You define an
agent (instructions + tools + provider), pick a transport (Baileys for personal-number/QR
login, the official WhatsApp Cloud API, or Twilio's WhatsApp API), and run.

```bash
npm create wappa-agent my-bot
```

## Features

- **Transport-agnostic core.** `@wappajs/core` never imports a WhatsApp library; it speaks a
  normalized message model. Adapters translate.
- **Provider-agnostic agent loop.** The core owns the tool-call loop and conversation
  memory. Providers (`@wappajs/anthropic`, `@wappajs/openai`) map one `generate()` call to
  their SDK, and `@wappajs/openai` works against any OpenAI-compatible server via `baseURL`.
- **Middleware-first extensibility.** grammY/Telegraf-style `use(ctx, next)`, plus
  `command()` and `hears()` routing. Auth, rate limiting, logging, transcription and
  handoff are all just middleware.
- **Typed tools with zod.** `defineTool` infers argument types from a zod schema,
  validates model-supplied arguments, and turns failures into retryable tool results
  instead of crashes.
- **Sessions built in.** Per-chat conversation history and durable data with in-memory
  and file-backed stores, and a lost-update-safe pause/resume flag for human handoff.
- **Prompt caching by construction.** Put the half of the prompt that never changes in
  `knowledge`; `@wappajs/anthropic` caches it, so a long catalogue costs a tenth on every
  message after the first.
- **Today's models, handled.** Adaptive-thinking models need their thinking blocks
  replayed inside a tool loop; the Anthropic provider keeps them on the session and
  sends them back, and exposes `effort` and `thinking` for tuning.
- **Any server.** The webhook transports mount into node:http or into any fetch-style
  host (Bun, Deno, Cloudflare Workers, Hono, Next.js) with `handleFetch(request)`.
- **Testability is a feature.** `@wappajs/core/testing` ships `MockTransport` and
  `ScriptedProvider`, so you can unit-test a whole bot offline, with no WhatsApp and no LLM key.
- **Per-chat concurrency model.** Messages within one chat are processed strictly in
  order; different chats run concurrently. Graceful shutdown drains in-flight turns.

## Architecture

```
                 WhatsApp
                     │
      ┌──────────────┴───────────────┐
      │           Transport          │   @wappajs/baileys    (personal number, QR login)
      │  QR / webhooks / Graph API   │   @wappajs/cloud-api  (official Meta Cloud API)
      │                              │   @wappajs/twilio     (Twilio WhatsApp BSP)
      └──────────────┬───────────────┘
                     │  InboundMessage / OutboundPayload (normalized)
      ┌──────────────┴───────────────┐
      │             Bot              │   per-chat queues · middleware chain
      │   use() · command() · hears()│   built-in router · session persistence
      └──────────────┬───────────────┘
                     │  Context (message, session, reply, state)
      ┌──────────────┴───────────────┐
      │            Agent             │   tool-call loop · history window
      │      defineTool + zod        │   error rollback · maxTurns cap
      └──────────────┬───────────────┘
                     │  GenerateRequest / GenerateResult
      ┌──────────────┴───────────────┐
      │           Provider           │   @wappajs/anthropic  (Claude)
      │        one generate()        │   @wappajs/openai     (GPT + compatible servers)
      └──────────────────────────────┘
```

## Quickstart: Baileys + Claude

The fastest path to a running agent: a personal WhatsApp number, logged in via QR code.

```bash
npm create wappa-agent my-bot -- --transport baileys --provider anthropic
```

Or wire it up by hand in an existing ESM project (Node >= 20):

```bash
npm install @wappajs/core @wappajs/baileys @wappajs/anthropic zod
```

```ts
// src/index.ts  (ESM, Node >= 20)
import { Agent, Bot, defineTool } from '@wappajs/core';
import { BaileysTransport } from '@wappajs/baileys';
import { AnthropicProvider } from '@wappajs/anthropic';
import { z } from 'zod';

const agent = new Agent({
  instructions: 'You are a helpful assistant reachable over WhatsApp. Keep replies short.',
  provider: new AnthropicProvider(), // reads ANTHROPIC_API_KEY from the environment
  tools: [
    defineTool({
      name: 'get_time',
      description: 'Get the current date and time.',
      parameters: z.object({}),
      execute: () => new Date().toString(),
    }),
  ],
});

const bot = new Bot({ transport: new BaileysTransport(), agent });

await bot.start(); // prints a QR code, scan it with WhatsApp on your phone
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx tsc && node dist/index.js
```

Auth state persists in `./wappa-auth`, so the QR scan is only needed once.

## Quickstart: Cloud API

The official transport runs a webhook server and sends through the Graph API:

```ts
import { Agent, Bot } from '@wappajs/core';
import { CloudApiTransport } from '@wappajs/cloud-api';
import { OpenAIProvider } from '@wappajs/openai';

const transport = new CloudApiTransport({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
  appSecret: process.env.WHATSAPP_APP_SECRET, // strongly recommended
  port: 3000,                                 // starts a node:http webhook server
});

const bot = new Bot({
  transport,
  agent: new Agent({
    instructions: 'You are a helpful WhatsApp assistant.',
    provider: new OpenAIProvider(), // reads OPENAI_API_KEY
  }),
});

await bot.start();
```

The Meta dashboard setup (app, phone number, webhook verification, app secret) is walked
through step by step in [docs/transports/cloud-api.md](docs/transports/cloud-api.md).

## Packages

| Package | What it is |
| --- | --- |
| [`@wappajs/core`](https://www.npmjs.com/package/@wappajs/core) | Transport-agnostic core: `Bot`, `Agent`, `defineTool`, sessions, middleware, logger |
| [`@wappajs/core/testing`](https://www.npmjs.com/package/@wappajs/core) | `MockTransport` + `ScriptedProvider` for offline tests |
| [`@wappajs/baileys`](https://www.npmjs.com/package/@wappajs/baileys) | Baileys transport, personal number via QR login (unofficial client, see below) |
| [`@wappajs/cloud-api`](https://www.npmjs.com/package/@wappajs/cloud-api) | Official WhatsApp Cloud API transport (Meta webhook + Graph API, no Meta SDK) |
| [`@wappajs/twilio`](https://www.npmjs.com/package/@wappajs/twilio) | Twilio WhatsApp transport (form-encoded webhook + Messages REST API, no Twilio SDK) |
| [`@wappajs/anthropic`](https://www.npmjs.com/package/@wappajs/anthropic) | Claude provider (Anthropic Messages API), default model `claude-sonnet-5` |
| [`@wappajs/openai`](https://www.npmjs.com/package/@wappajs/openai) | OpenAI provider (Chat Completions), default model `gpt-5`; `baseURL` for Ollama etc. |
| [`create-wappa-agent`](https://www.npmjs.com/package/create-wappa-agent) | Project scaffolder: `npm create wappa-agent my-bot` |

## Documentation

- [Getting started](docs/getting-started.md): install options and first run
- [Concepts](docs/concepts.md): Bot pipeline, Agent loop, tools, sessions, middleware, handoff
- [Baileys transport](docs/transports/baileys.md)
- [Cloud API transport](docs/transports/cloud-api.md)
- [Twilio transport](docs/transports/twilio.md)
- [Providers](docs/providers.md): Anthropic, OpenAI, OpenAI-compatible servers, custom providers
- [Testing](docs/testing.md): unit-testing bots with `MockTransport` + `ScriptedProvider`
- [Recipes](docs/recipes.md): handoff, media, groups, proactive messages, transcription, rate limits

Release history is in [CHANGELOG.md](CHANGELOG.md), and the release process in
[RELEASING.md](RELEASING.md).

Runnable examples live in [`examples/`](examples/): `echo-bot` (router-only, no LLM),
`support-agent` (Claude + tools + Baileys, the flagship), and `cloud-api-agent`
(OpenAI + Cloud API webhook deployment).

## Roadmap

Deliberately **not** in v0.1 (several have recipes showing how to do them yourself in
[docs/recipes.md](docs/recipes.md)):

- Streaming replies
- WhatsApp flows/forms
- Built-in voice transcription (recipe: transcription middleware)
- Scheduled/cron messages (recipe: plain `setInterval` + `bot.send`)
- Built-in group mention filtering (recipe: middleware using `bot.selfId`)
- Analytics / admin UI
- Redis session store

## A note on Baileys and WhatsApp's Terms of Service

`@wappajs/baileys` builds on [Baileys](https://github.com/WhiskeySockets/Baileys), an
**unofficial** WhatsApp Web client. Using it may violate WhatsApp's Terms of Service and
**can get phone numbers banned**. Use a number you can afford to lose, and prefer an
official transport (`@wappajs/cloud-api` or `@wappajs/twilio`) for anything production-grade.

## License

[MIT](LICENSE)
