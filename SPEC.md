# wappa — WhatsApp Agent Framework — Architecture Specification

**Status: FROZEN CONTRACT for v0.1.0.** Implementation must match the interfaces in this
document exactly (names, signatures, defaults). Anything not specified here is an
implementation detail — use good judgment and keep it minimal.

## What wappa is

`wappa` is a TypeScript framework for building WhatsApp agents — bots whose "brain" is an
LLM with tool-calling, and whose "body" is a pluggable WhatsApp transport. Users install
the packages, define an agent (instructions + tools + LLM provider), pick a transport
(Baileys for personal-number/QR login, or the official WhatsApp Cloud API), and run.

Design pillars:

1. **Transport-agnostic core.** The core never imports a WhatsApp library. It speaks a
   normalized message model. Adapters translate.
2. **Provider-agnostic agent loop.** The core owns the tool-call loop and conversation
   memory; providers only map one `generate()` call to their SDK.
3. **Middleware-first extensibility** (grammY/Telegraf-style `use(ctx, next)`), so any
   cross-cutting concern (auth, rate limiting, logging, handoff) is a middleware.
4. **Batteries included, swappable**: in-memory + file session stores, mock
   transport + scripted provider for testing, rate-limit middleware, CLI scaffolder.
5. **Testability is a feature**: `@wappajs/core/testing` ships `MockTransport` and
   `ScriptedProvider` so users can unit-test bots without WhatsApp or an LLM key.

## Monorepo layout

```
wappa/
├── package.json                # private, npm workspaces: packages/*, examples/*
├── tsconfig.base.json
├── tsconfig.json               # solution file: references all packages (tsc -b)
├── vitest.config.ts            # root config, projects: packages/*
├── SPEC.md                     # this file
├── README.md
├── docs/
│   ├── getting-started.md
│   ├── concepts.md             # agents, tools, middleware, sessions, context
│   ├── transports/baileys.md
│   ├── transports/cloud-api.md
│   ├── providers.md
│   ├── testing.md
│   └── recipes.md              # handoff, media, groups, proactive messages, rate limits
├── packages/
│   ├── core/                   # @wappajs/core
│   ├── baileys/                # @wappajs/baileys
│   ├── cloud-api/              # @wappajs/cloud-api
│   ├── anthropic/              # @wappajs/anthropic
│   ├── openai/                 # @wappajs/openai
│   └── create-wappa-agent/      # create-wappa-agent (npm create wappa-agent)
└── examples/
    ├── echo-bot/               # no LLM: middleware + router only, MockTransport demo + baileys
    ├── support-agent/          # Claude + tools + Baileys; the flagship example
    └── cloud-api-agent/        # OpenAI + Cloud API webhook deployment example
```

Every package: `"type": "module"` (ESM-only), Node `>=20`, built with plain `tsc`
(project references, `tsc -b` at root), `dist/` output with `.d.ts`, `exports` map with
`types` condition first. TypeScript `~5.9.0` pinned at root. Tests with vitest, colocated
under `src/**/*.test.ts`, excluded from build via a separate `tsconfig.json`
(`"exclude": ["**/*.test.ts", "dist"]`).

Versions (already resolved against the registry, do not change): `baileys@7.0.0-rc14`,
`@anthropic-ai/sdk@^0.123.0`, `openai@^7.9.0`, `zod@^4.5.4`, `typescript@~5.9.0`,
`vitest@^5.0.0`, `qrcode-terminal@^0.12.0`, `pino@^10.3.1`.

---

## Additions in 0.2.0

The 0.1.0 contract below is unchanged; 0.2.0 adds to it, and every addition is optional
for existing providers and transports:

- `AgentOptions.knowledge?: string | ((ctx) => string | Promise<string>)`: the stable half
  of the system prompt, sent before `instructions`. `GenerateRequest.system` stays the
  complete prompt; `GenerateRequest.systemParts?: { stable, dynamic }` carries the split.
- `GenerateResult.providerData?: unknown` and `ChatMessage.providerData?: unknown`: opaque,
  provider-owned, JSON-serializable. The Agent copies it from the result onto the
  assistant message it appends (tool-calling turns and the final text alike); session
  stores persist it with the history. `ScriptedProvider` passes it through.
- `AnthropicProviderOptions.effort`, `.thinking`, `.extraParams`; the provider caches
  `systemParts.stable` with a cache breakpoint and replays `providerData` content blocks
  (rebuilt as request blocks) in place of reconstructing an assistant turn from text and
  tool calls.
- `TwilioTransport.handleFetch(request: Request): Promise<Response>` and
  `CloudApiTransport.handleFetch(request: Request): Promise<Response>`: the WHATWG twins of
  `handleRequest`. No `webhookPath` check; the host routes. Same status codes.

# @wappajs/core

Dependencies: `zod` only. Dev: vitest, typescript.

Exports (package root `@wappajs/core`): everything below except the testing utilities.
Subpath export `@wappajs/core/testing`: `MockTransport`, `ScriptedProvider`.

## Message model (`src/messages.ts`)

Chat and user ids are opaque strings, transport-specific (Baileys JIDs like
`123456789@s.whatsapp.net`, Cloud API phone numbers like `15551234567`). Core never
parses them.

```ts
export type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker';

/** Inbound media. Download is lazy — adapters implement it. */
export interface MediaRef {
  kind: MediaKind;
  download(): Promise<Buffer>;
  mimetype?: string;
  filename?: string;
  /** true for voice notes */
  ptt?: boolean;
}

export interface Location {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface QuotedRef {
  id: string;
  text?: string;
  senderId?: string;
}

export interface InboundMessage {
  id: string;
  /** Conversation id — group id or peer id. Replies go here. */
  chatId: string;
  /** Author id. Equals chatId in a DM; the member's id in a group. */
  senderId: string;
  senderName?: string;
  /** ms since epoch */
  timestamp: number;
  isGroup: boolean;
  fromMe: boolean;
  /** Text body, or media caption, or interactive button/list reply title. */
  text?: string;
  media?: MediaRef;
  location?: Location;
  reaction?: { emoji: string; targetMessageId: string };
  quoted?: QuotedRef;
  /** Interactive reply id (Cloud API button_reply/list_reply). Absent on Baileys. */
  buttonId?: string;
  /** Adapter-specific raw event, for escape hatches. */
  raw?: unknown;
}

export interface OutboundMedia {
  kind: MediaKind;
  /** Buffer, or a URL (https:) or local file path — adapter resolves. */
  data: Buffer | string;
  mimetype?: string;
  filename?: string;
  caption?: string;
  ptt?: boolean;
}

/**
 * Quick-reply button. `id` round-trips only on Cloud API (see InboundMessage.buttonId);
 * on Baileys the reply arrives as plain text (the number or title the user typed), so
 * portable routing should match on `title` via hears().
 */
export interface OutboundButton { id: string; title: string }

export interface OutboundPayload {
  text?: string;
  media?: OutboundMedia;
  location?: Location;
  /**
   * Quick-reply buttons (max 3 — Cloud API limit). Cloud API renders native
   * buttons; Baileys renders a numbered text fallback appended to `text`.
   */
  buttons?: OutboundButton[];
  /** Message id to quote-reply to. Best-effort. */
  replyTo?: string;
}

export type OutboundContent = string | OutboundPayload;

export interface SendResult { id?: string }

/** Normalize string -> OutboundPayload. Exported helper used by adapters/tests. */
export function toPayload(content: OutboundContent): OutboundPayload;
```

## Transport interface (`src/transport.ts`)

```ts
export interface TransportHandlers {
  onMessage(msg: InboundMessage): void | Promise<void>;
  onReady?(info: { selfId?: string }): void;
  onError?(err: Error): void;
  onDisconnect?(reason?: string): void;
}

export interface Transport {
  readonly name: string;
  /**
   * Start the transport and begin delivering events. Adapters may resolve before
   * authentication completes (e.g. Baileys resolves during the QR flow) — see adapter docs.
   */
  start(handlers: TransportHandlers): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, content: OutboundContent): Promise<SendResult>;
  /** Optional capabilities — Bot feature-detects by presence. */
  sendTyping?(chatId: string, on: boolean): Promise<void>;
  markRead?(chatId: string, messageId: string): Promise<void>;
}
```

## Provider interface (`src/provider.ts`)

```ts
export type Role = 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  /** Text content. Empty string allowed (e.g. assistant message that only calls tools). */
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on role 'tool' messages. */
  toolCallId?: string;
  toolName?: string;
}

/** JSON Schema object for tool parameters. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface GenerateRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResult {
  /** Final assistant text, or null if the model only called tools. */
  text: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface Provider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
```

Note there is no `system` role in `ChatMessage`: the system prompt travels separately in
`GenerateRequest.system` because every provider treats it specially.

## Tools (`src/tool.ts`)

```ts
import type { ZodType, infer as zInfer } from 'zod';

/**
 * S is either a zod schema (args inferred) or a raw JSON Schema (args = Record).
 * NOTE: the union lives in the CONSTRAINT, not in the property type — this is what
 * makes both paths infer correctly (verified against TS 5.9 + zod 4).
 */
export interface ToolDefinition<S extends ZodType | JsonSchema = JsonSchema> {
  name: string;                    // ^[a-zA-Z0-9_-]{1,64}$ — validate in defineTool
  description: string;
  /** Zod schema (recommended) or raw JSON Schema object. Omitted = no parameters. */
  parameters?: S;
  execute(args: S extends ZodType ? zInfer<S> : Record<string, unknown>, ctx: Context):
    Promise<unknown> | unknown;
}

export interface Tool {
  name: string;
  description: string;
  /** Resolved JSON Schema (zod converted via z.toJSONSchema; default {type:'object',properties:{}}). */
  parameters: JsonSchema;
  /** Validates args (zod .parse when zod was given), runs execute, stringifies result. */
  invoke(args: Record<string, unknown>, ctx: Context): Promise<string>;
}

export function defineTool<S extends ZodType | JsonSchema = JsonSchema>(
  def: ToolDefinition<S>
): Tool;
```

Runtime zod detection: `parameters instanceof ZodType`, with a duck-type fallback
(`typeof (parameters as any)?.safeParse === 'function'`).

Zod conversion MUST use `toJSONSchema(schema, { io: 'input' })` — the model sends the
schema's INPUT type. The default (output io) crashes on `.transform()` schemas at
definition time and advertises the wrong type for `.pipe()` schemas.

`invoke` behavior: validate args (on zod failure, DO NOT throw — return the validation
error as the tool result string so the model can retry); call `execute`; stringify the
result: `string` as-is; `null`/`undefined` → `"ok"`; objects/arrays → `JSON.stringify`;
other primitives → `String(value)`; thrown errors → `"Error: <message>"` as the result
string (agent loop must not crash on a failing tool).

## Sessions (`src/session.ts`)

```ts
export interface SessionData {
  history: ChatMessage[];
  /** Arbitrary user data persisted across messages (named `data`, not `state`, to avoid confusion with the ephemeral ctx.state). */
  data: Record<string, unknown>;
  /** Human-handoff flag: when true, router + agent are skipped. */
  paused?: boolean;
  updatedAt: number;
}

export function createSession(): SessionData; // { history: [], data: {}, updatedAt: 0 }

export interface SessionStore {
  get(chatId: string): Promise<SessionData | undefined>;
  set(chatId: string, data: SessionData): Promise<void>;
  delete(chatId: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore { /* Map-backed */ }

/**
 * One JSON file per chat under dir; chatId sanitized for filenames (encodeURIComponent).
 * Atomic-ish write (tmp+rename; dir created 0o700, files written 0o600 — transcripts
 * are PII). get() returns undefined ONLY for a missing file (ENOENT), unparseable JSON,
 * or a parsed value with the wrong shape (history not an array / data not an object) —
 * corrupt files self-heal, but any OTHER error (EACCES, EMFILE, EIO, …) RETHROWS:
 * a transient FS error must not masquerade as "no session" and let the end-of-turn
 * save destroy real history and the paused flag.
 */
export class FileSessionStore implements SessionStore {
  constructor(dir: string);
}
```

## Context (`src/context.ts`)

```ts
export interface Context {
  message: InboundMessage;
  bot: Bot;
  /** Loaded session — mutate freely; Bot saves it after the pipeline finishes. */
  session: SessionData;
  /**
   * Per-message scratch space for middleware. Not persisted — durable data belongs in
   * ctx.session.data. The router sets ctx.state.commandArgs (string) before invoking a
   * command handler.
   */
  state: Record<string, unknown>;
  reply(content: OutboundContent): Promise<SendResult>;   // send to message.chatId
  sendTyping(on?: boolean): Promise<void>;                // no-op if unsupported; default on=true
  logger: Logger;
}
```

## Logger (`src/logger.ts`)

Minimal structural interface so pino/console both fit; no dependency:

```ts
export interface Logger {
  debug(msg: string, data?: object): void;
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}
export function consoleLogger(level?: 'debug' | 'info' | 'warn' | 'error'): Logger; // default 'info'
```

## Agent (`src/agent.ts`)

```ts
export interface AgentOptions {
  /** System prompt. Function form is re-evaluated per message. */
  instructions: string | ((ctx: Context) => string | Promise<string>);
  provider: Provider;
  tools?: Tool[];
  /** Max provider round-trips per inbound message (tool loop cap). Default 8. */
  maxTurns?: number;
  /** History window: max ChatMessages kept in session history. Default 40. */
  maxHistoryMessages?: number;
  /**
   * Size cap applied after the count trim (default 200_000 chars): drops the OLDEST
   * whole user-turn group while total content chars exceed it, never splitting
   * assistant-toolCalls/tool groups and always keeping the final user message.
   * Prevents oversized pastes from permanently exceeding the model context (failed
   * turns roll back, so an oversized window would otherwise retry forever).
   */
  maxHistoryChars?: number;
  maxTokens?: number;      // default 1024
  temperature?: number;    // omitted unless set
}

export class Agent {
  constructor(opts: AgentOptions);
  /**
   * Run one agentic turn for ctx.message:
   * 1. Append user message built from the inbound (see "user message rendering").
   * 2. Loop: provider.generate(system, windowed history, tool specs)
   *    - execute tool calls sequentially via tool.invoke(args, ctx),
   *      append assistant msg (with toolCalls) + one 'tool' msg per call.
   *    - a requested tool name that is NOT registered must not throw: append a
   *      role:'tool' message with that call's id and content `Error: unknown tool <name>`
   *      and continue the loop, same as a failing tool.
   *    - stop when the model returns text with no tool calls, or maxTurns reached.
   * 3. Append final assistant message ONLY if text is non-null/non-empty. Invariant:
   *    history never contains an assistant message with empty content and no toolCalls
   *    (the Anthropic API rejects those on the next turn).
   *    Trim history to maxHistoryMessages (never splitting an
   *    assistant-toolCalls/tool-results group at the window edge — drop the whole group).
   *    WINDOW INVARIANT: the trimmed request window must START with a role:'user'
   *    message (align forward to the next user message — Anthropic rejects
   *    assistant-first requests); if alignment empties the window, fall back to slicing
   *    from the LAST user message so the request always contains the current user turn
   *    (the window may then exceed maxHistoryMessages — a non-empty valid request wins).
   *    Then apply the maxHistoryChars size cap (see AgentOptions).
   * 4. Return final text (null if none).
   * Error handling: if generate or the loop throws, restore session.history to its
   * pre-run snapshot before propagating — a failed turn is never persisted (the Bot
   * saves the session even on error).
   * Does NOT send the reply — Bot does. Session persistence is Bot's job.
   */
  run(ctx: Context): Promise<string | null>;
}
```

User message rendering: `text` if present; media-only → `[image]`/`[voice note]`/etc
placeholder plus caption; location → `[location: lat, lon]`. In groups, prefix with the
sender: `senderName || senderId` + `: `. If maxTurns is hit while the model still wants
tools, do a final `generate` WITHOUT tools to force a text answer.

## Middleware & routing (`src/bot.ts`)

```ts
export type NextFunction = () => Promise<void>;
export type Middleware = (ctx: Context, next: NextFunction) => void | Promise<void>;
export type Handler = (ctx: Context) => void | Promise<void>;

export interface BotOptions {
  transport: Transport;
  /** Default handler when no command/hears route matched. Optional — router-only bots are valid. */
  agent?: Agent;
  sessions?: SessionStore;        // default new MemorySessionStore()
  ignoreFromMe?: boolean;         // default true
  ignoreGroups?: boolean;         // default false
  /** Allowlist of senderIds; others are silently dropped. Omit = allow all. */
  allowFrom?: string[];
  logger?: Logger;                // default consoleLogger()
  /** Called on any pipeline error. Default: logger.error. */
  onError?: (err: Error, ctx?: Context) => void;
  /** Send typing indicator while the agent thinks. Default true. */
  typingIndicator?: boolean;
}

export class Bot {
  constructor(opts: BotOptions);
  readonly transport: Transport;
  /** Self id once known (transport onReady). */
  selfId?: string;

  use(mw: Middleware): this;
  /**
   * Command routing. A missing leading '/' is normalized ('reset' === '/reset').
   * Match rule (case-insensitive, after trimming leading whitespace): the text equals
   * the command, or starts with the command followed by whitespace — '/reset' matches
   * '/reset' and '/reset now', NEVER '/resetall'. Before invoking the handler the
   * router sets ctx.state.commandArgs to the trimmed remainder ('' if none).
   */
  command(cmd: string, handler: Handler): this;
  /**
   * String pattern: matches when the whole trimmed text equals it case-insensitively
   * (exact trigger, Telegraf-style — NOT substring). RegExp: tested against the raw text.
   */
  hears(pattern: string | RegExp, handler: Handler): this;
  /** Lifecycle events only — message handling belongs to use()/command()/hears()/agent. */
  on(event: 'ready', l: (info: { selfId?: string }) => void): this;
  on(event: 'error', l: (err: Error) => void): this;
  on(event: 'disconnect', l: (reason?: string) => void): this;

  start(): Promise<void>;
  /**
   * Graceful shutdown: stop enqueueing new inbound messages (drop them), await all
   * per-chat queues to drain (in-flight turns finish and their sessions save), then
   * transport.stop(). Idempotent.
   */
  stop(): Promise<void>;

  /** Proactive send, usable any time after start. */
  send(chatId: string, content: OutboundContent): Promise<SendResult>;

  /** Human handoff: pause/resume the agent for one chat (persisted in session). */
  pause(chatId: string): Promise<void>;
  resume(chatId: string): Promise<void>;
}
```

### Pipeline (exact order)

For each inbound message:

1. Drop if `fromMe` && `ignoreFromMe`; drop if `isGroup` && `ignoreGroups`; drop if
   `allowFrom` set and `senderId` not in it; drop if the bot is stopping/stopped.
2. Enqueue on a **per-chat queue** (promise chain keyed by chatId) — messages within one
   chat are processed strictly sequentially; different chats run concurrently. Prune the
   queue entry when it drains.
3. Load session (or `createSession()`), build Context. Register the Context as the
   chat's live in-flight context (see pause/resume) until step 5 completes.
4. Run middleware chain (`use` order), innermost handler is the **built-in router**:
   a. If `session.paused` → stop (no routing, no agent).
   b. Messages with no `text` (e.g. reaction-only, or media-less unmapped content) skip
      routing and the agent entirely — middleware still ran; observation middleware is
      the way to react to them.
   c. First matching `command`, else first matching `hears` → run its handler; done.
   d. Else if `agent` configured → `typingIndicator && ctx.sendTyping(true)` (GUARDED —
      typing is cosmetic; a transport typing failure must never abort the turn);
      `const text = await agent.run(ctx)`; if text, `ctx.reply(text)`;
      finally `ctx.sendTyping(false)` (guarded, ignore errors).
   e. Else: do nothing.
5. Save session (`updatedAt = Date.now()`).
6. Errors anywhere → `onError(err, ctx)`; session is still saved if loaded.

Middleware semantics: standard koa-style; not calling `next()` stops the chain
(router included). Calling next() twice → throw `Error('next() called multiple times')`.

### pause/resume semantics (lost-update safe)

`pause(chatId)`/`resume(chatId)` MUST NOT do a naive independent load→mutate→save — that
races the pipeline's step-5 save (deterministic lost update with any store that returns
copies, e.g. FileSessionStore). Required behavior:

- If the chat has a live in-flight Context (its pipeline is currently running — the
  common case when a tool calls `ctx.bot.pause(ctx.message.chatId)`): mutate that
  live `ctx.session.paused` directly and return; the pipeline's own save persists it.
  This must NOT enqueue on the per-chat queue (deadlock: the current turn holds it).
- Otherwise: enqueue a load→mutate→save job on the chat's per-chat queue, so it
  serializes with message processing.

Inside a handler/tool for the *current* chat, `ctx.session.paused = true` is equivalent
and the most direct form — examples should use it.

### Built-in middleware helpers (`src/middleware.ts`)

```ts
/**
 * Fixed-window counter per chat: allows at most `max` messages per `windowMs`; the
 * counter resets when the window elapses. Over-limit messages are dropped — onLimit is
 * called (awaited, errors to ctx.logger) and next() is NOT called.
 */
export function rateLimit(opts?: {
  windowMs?: number;      // default 60_000
  max?: number;           // default 20 msgs per window per chat
  /** Return value ignored (loose type so `(ctx) => ctx.reply('…')` compiles). */
  onLimit?: (ctx: Context) => unknown;
}): Middleware;
```

The per-chat window map must not grow unboundedly: when an insert grows it past a
threshold (1000), sweep out all expired windows.

## Testing utilities (`src/testing.ts`, exported as `@wappajs/core/testing`)

```ts
/** In-memory transport for tests. */
export class MockTransport implements Transport {
  readonly name: 'mock';
  /** Everything sent via send(), in order. */
  readonly sent: Array<{ chatId: string; payload: OutboundPayload }>;
  start(h: TransportHandlers): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, content: OutboundContent): Promise<SendResult>;
  /**
   * Simulate an inbound message; returns once the pipeline (incl. async handling)
   * settles. Defaults (exact, so user tests can assert on them): chatId 'test-chat',
   * senderId = chatId, id 'msg-<n>' (incrementing per transport instance),
   * timestamp Date.now(), isGroup false, fromMe false.
   */
  receive(partial: Partial<InboundMessage> & { text?: string }): Promise<void>;
}

/** Provider that replays scripted results; records every GenerateRequest. */
export class ScriptedProvider implements Provider {
  readonly name: 'scripted';
  readonly calls: GenerateRequest[];
  /**
   * string s === { text: s, toolCalls: [], finishReason: 'stop' }.
   * Partial entries are completed with { text: null, toolCalls: [],
   * finishReason: toolCalls.length ? 'tool_calls' : 'stop' } (explicit fields win).
   * generate() past the end of the script rejects with
   * Error('ScriptedProvider: script exhausted (call <n> of <len>)') — loops fail loudly.
   */
  constructor(script: Array<Partial<GenerateResult> | string>);
}
```

`MockTransport.receive` must await the full pipeline: implement by having `receive` await
`handlers.onMessage(msg)` — Bot's onMessage returns a promise that resolves when the
message's queue turn finishes.

## Core tests (vitest, colocated)

Cover at minimum: toPayload; defineTool (zod validation, error-as-string, JSON-schema
pass-through, name validation, primitive-result stringification); Memory/File session
stores (File: real tmp dir; corrupt JSON → undefined); middleware order + next()
double-call; command matching ('/reset' matches '/reset now' but NOT '/resetall';
commandArgs set; missing '/' normalized); hears exact-trimmed-match (no substring
firing) + RegExp; pause skips agent; pause from within a tool persists with
FileSessionStore (the lost-update regression test); per-chat serialization (two receives
on same chat run in order; different chats interleave); agent loop with ScriptedProvider
(tool call executed, results appended, unknown tool name → error tool-result and loop
continues, maxTurns forces final no-tools call, null final text appends nothing, error
mid-loop restores pre-run history, history trimming keeps groups intact); rateLimit
(fixed window, onLimit called, next not called); buttons in toPayload; contentless
message skips agent; Bot.stop drains in-flight turns; Bot end-to-end with
MockTransport + ScriptedProvider.

---

# @wappajs/baileys

Deps: `baileys@7.0.0-rc14`, `qrcode-terminal`, `pino` (baileys wants a pino-like logger),
`@wappajs/core` (workspace). **Verify all baileys API names against the installed
`node_modules/baileys` type declarations before writing code — do not trust memory; the
7.x RC renamed things.**

```ts
export interface BaileysTransportOptions {
  /** Directory for multi-file auth state. Default './wappa-auth'. */
  authDir?: string;
  /** Print QR to terminal on login. Default true. */
  printQR?: boolean;
  /** Called with the raw QR string (for custom rendering). */
  onQR?: (qr: string) => void;
  logger?: Logger;               // wappa logger for adapter logs
  /** Baileys' own log level. Default 'silent'. */
  baileysLogLevel?: string;
}

export class BaileysTransport implements Transport {
  readonly name: 'baileys';
  constructor(opts?: BaileysTransportOptions);
}
```

Behavior:
- `start`: `useMultiFileAuthState(authDir)`, create socket, wire `connection.update`
  (QR → print/callback; open → onReady with selfId from `sock.user.id`; close →
  reconnect automatically with capped backoff unless the disconnect reason is
  `loggedOut`, then onDisconnect). `start()` resolves when the socket is created (not
  when logged in) BUT must keep working through the QR flow; document this.
- `messages.upsert` (type `notify` only) → map each message to `InboundMessage`:
  conversation/extendedTextMessage text; image/video/audio/document/sticker → MediaRef
  whose `download()` uses baileys' `downloadMediaMessage`; caption → text;
  locationMessage; reactionMessage; contextInfo → quoted. Skip protocol/system messages
  (no mappable content) silently. `chatId = key.remoteJid`, group = jid ends with
  `@g.us`, `senderId = key.participant ?? key.remoteJid`, `fromMe = key.fromMe`,
  `senderName = pushName`.
- `send`: text → `{ text }`; media Buffer/path/url → appropriate baileys content
  (image/video/document/audio with ptt); location; `replyTo` → `quoted` best-effort (may
  require the original message — if not cheaply available, skip quoting rather than
  fail, and document); buttons → numbered text fallback:
  `text + '\n\n1. Title A\n2. Title B'`.
- `sendTyping` → `sendPresenceUpdate('composing' | 'paused', chatId)`; while
  disconnected/reconnecting it is a silent no-op (debug log) — typing is cosmetic and
  must never kill a turn that would succeed after the auto-reconnect.
- `markRead` → `readMessages`.
- `send()` while disconnected/reconnecting rejects with an Error (no internal outbound
  queueing in v0.1); callers observe it via onError. Document in transports/baileys.md.
- Auth dir is created (or tightened) to mode 0o700 before `useMultiFileAuthState` —
  creds.json is account-takeover material on shared hosts.
- Skip messages from `@broadcast` AND `@newsletter` (WhatsApp Channels) jids — channel
  posts otherwise map to plausible DMs and trigger agent turns.
- `stop` → `sock.end`/logout-less close; make idempotent.

Tests: pure mapping helpers extracted into `mapping.ts` and unit-tested with
fixture objects copied from real baileys shapes (no socket in tests). Button fallback
rendering tested.

---

# @wappajs/cloud-api

Deps: `@wappajs/core` only (use global `fetch` — Node 20+). No Meta SDK.

```ts
export interface CloudApiTransportOptions {
  accessToken: string;
  phoneNumberId: string;
  /** Webhook verify token you configure in the Meta app dashboard. */
  verifyToken: string;
  /** App secret for X-Hub-Signature-256 validation. Strongly recommended; if omitted, signature is not checked (log a warning). */
  appSecret?: string;
  /** If set, transport starts its own node:http server on this port. */
  port?: number;
  webhookPath?: string;          // default '/webhook'
  graphApiVersion?: string;      // default 'v23.0'
  baseUrl?: string;              // default 'https://graph.facebook.com' (override for tests)
  logger?: Logger;
}

export class CloudApiTransport implements Transport {
  readonly name: 'cloud-api';
  constructor(opts: CloudApiTransportOptions);
  /**
   * Mount into an existing Node http(s) server: handles GET hub.challenge verification
   * and POST event delivery. Returns true if the request was handled (path matched).
   * Reads the raw body itself UNLESS rawBody is provided — pass rawBody when a
   * framework body-parser already consumed the stream (Express: use
   * express.raw({ type: '*/*' }) on the webhook path and pass req.body). The HMAC
   * signature check always runs over these exact raw bytes.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse, rawBody?: Buffer): Promise<boolean>;
}
```

Behavior:
- Webhook GET: verify `hub.mode === 'subscribe'` && `hub.verify_token === verifyToken` →
  200 + `hub.challenge`, else 403.
- Webhook POST: if appSecret set, verify `X-Hub-Signature-256` (HMAC-SHA256 of the RAW
  body, timing-safe compare) — invalid → 401, don't process. Then 200 immediately and
  process async. Parse `entry[].changes[].value.messages[]`; map: text.body; interactive
  (`button_reply`/`list_reply` → text = title, `buttonId` = id); button (template replies);
  image/audio/video/document/sticker → MediaRef whose `download()` does GET
  `/{media-id}` → get url → GET url with Bearer token → Buffer; location; reaction;
  context → quoted. `chatId = messages[].from`, `senderId = from`,
  `senderName` resolved per message via `contacts.find(c => c.wa_id === msg.from)`
  (fallback `contacts[0]` — Meta batches multiple senders per value), `isGroup = false`
  (Cloud API is DM-only — document), `timestamp = Number(timestamp) * 1000`. Ignore
  `statuses` events. Messages of any unmapped type (contacts, order, system,
  unsupported, unknown) are skipped silently (debug-log only), mirroring the Baileys
  protocol-message rule.
  Delivery rules: (1) DEDUP — Meta delivers at-least-once; keep a bounded (≈1000,
  insertion-order eviction) set of seen message ids and skip redelivered wamids.
  (2) NON-BLOCKING — deliver each message without awaiting the full Bot pipeline
  (`void Promise.resolve(onMessage(msg)).catch(→ onError)`); Bot's synchronous per-chat
  enqueue preserves ordering, and one slow chat must not stall the rest of a batch.
  (3) The webhook body cap defaults to 1 MiB (pre-auth buffering; real events < 100 KB).
  (4) `lastInboundId` (typing-indicator support) is capped at ≈1000 entries.
- `send`: POST `/{phoneNumberId}/messages` with `messaging_product: 'whatsapp'`:
  text → `{ type:'text', text:{ body, preview_url:true } }`; buttons →
  `type:'interactive'`, `interactive.type:'button'` with up to 3 reply buttons (>3 →
  throw); media: URL string → link form; Buffer/local path → upload via `/{phoneNumberId}/media`
  (multipart FormData; global FormData/Blob in Node 20+) then send by id; location;
  `replyTo` → `context: { message_id }`. Non-2xx → throw Error including status +
  response body.
- `sendTyping(chatId, true)` requires a message id in Cloud API (typing is tied to
  marking a message read): keep the last inbound message id per chat; if available, POST
  status `read` with `typing_indicator: { type: 'text' }`; if none, no-op.
  `sendTyping(false)` is a no-op (Cloud API auto-clears). The POST is BEST-EFFORT:
  failures are caught and debug-logged, never thrown.
- media + buttons in one payload: attach the media as the interactive message header
  (image/video/document — link form for URLs, id form for uploaded Buffer/path media);
  audio/sticker cannot be a header → logger.warn that the media is dropped.
- `markRead` → POST status read with the message id.
- `start` with `port` → node:http server routing every request through `handleRequest`,
  404 otherwise. Without `port`, `start` just validates config (user mounts
  `handleRequest` themselves).

Tests: GET verification (accept/reject), POST signature (valid/invalid/missing+secret,
missing+no-secret), payload mapping fixtures (text, button reply, image, location,
statuses-ignored), send payload construction + error propagation, >3 buttons throws —
run the transport against a real `node:http` server on an ephemeral port with a stubbed
`baseUrl` pointing at a local fake Graph server.

---

# @wappajs/twilio

Deps: `@wappajs/core` only (global `fetch`, `node:http`, `node:crypto` — no Twilio SDK).
Twilio is a WhatsApp BSP: inbound arrives as form-encoded webhooks, outbound goes
through the Twilio Messages REST API with basic auth.

```ts
export interface TwilioTransportOptions {
  accountSid: string;            // ACxxxx
  authToken: string;             // used for basic auth AND webhook signature validation
  /** Your Twilio WhatsApp sender, with or without the 'whatsapp:' prefix. */
  whatsappNumber: string;        // e.g. 'whatsapp:+14155238886' or '+14155238886'
  /** If set, transport starts its own node:http server on this port. */
  port?: number;
  webhookPath?: string;          // default '/webhook'
  /**
   * The exact public URL Twilio POSTs to (scheme + host + path), used for
   * X-Twilio-Signature validation. STRONGLY recommended behind proxies/tunnels;
   * if omitted OR empty ('' from an unset env var via --env-file behaves like
   * undefined), reconstructed as 'https://' + Host header + path (warn once).
   */
  webhookUrl?: string;
  /** Disable signature validation (tests only). Default true. */
  validateSignature?: boolean;
  apiBaseUrl?: string;           // default 'https://api.twilio.com' (override for tests)
  logger?: Logger;
}

export class TwilioTransport implements Transport {
  readonly name: 'twilio';
  constructor(opts: TwilioTransportOptions);
  /** Mount into an existing server; same contract as CloudApiTransport.handleRequest. */
  handleRequest(req: IncomingMessage, res: ServerResponse, rawBody?: Buffer): Promise<boolean>;
}
```

Behavior:
- Webhook POST (application/x-www-form-urlencoded): validate `X-Twilio-Signature`
  when validateSignature (default true): base64 HMAC-SHA1 over
  `<webhookUrl><key1><value1>...` with params sorted by key, timing-safe compare
  (hash both sides first); invalid → 403, don't process. Valid → respond immediately
  with 200 `Content-Type: text/xml` body `<Response/>` (empty TwiML so Twilio sends no
  auto-reply), then process async (NON-BLOCKING delivery + bounded ≈1000-entry
  `MessageSid` DEDUP, mirroring the cloud-api rules). Body cap 1 MiB.
- Skip status callbacks: any request with `MessageStatus`/`SmsStatus` and no
  inbound content (no Body, NumMedia 0) is acknowledged and ignored.
- Inbound mapping → InboundMessage:
  `id = MessageSid`; `chatId = senderId = From` VERBATIM (e.g. 'whatsapp:+15551234567' —
  ids are transport-specific and this round-trips into send());
  `senderName = ProfileName`; `isGroup = false` (Twilio WhatsApp is DM-only);
  `fromMe = false`; `timestamp = Date.now()` (Twilio sends no epoch);
  `text = Body` (or ButtonText); `buttonId = ButtonPayload` (template quick replies);
  `NumMedia > 0` → `media` = lazy MediaRef for MediaUrl0 (GET following redirects →
  Buffer; the basic-auth header is sent ONLY when the URL's origin equals apiBaseUrl's —
  MediaUrl values come from the webhook payload and credentials must never reach a
  foreign host; kind derived from MediaContentType0, ptt for audio/ogg voice);
  `Latitude`/`Longitude` → location; `MessageType === 'reaction'` → reaction with
  emoji = Body and targetMessageId = OriginalRepliedMessageSid;
  `OriginalRepliedMessageSid` (non-reaction) → quoted { id }. Full param bag on `raw`.
  Unmapped/contentless payloads are skipped silently (debug log).
- `send(chatId, content)`: POST
  `{apiBaseUrl}/2010-04-01/Accounts/{accountSid}/Messages.json` (basic auth,
  form-encoded): `From` = whatsappNumber (whatsapp:-prefixed), `To` = chatId
  ('whatsapp:' prepended when missing), `Body` = text, media URL → `MediaUrl`
  (Twilio has NO binary upload for messaging: Buffer/local-path media → throw a clear
  Error saying Twilio needs a public URL), location →
  `PersistentAction = ['geo:{lat},{lon}|{name}']` PLUS a synthesized Body when none is
  set (`name ?? address ?? '{lat},{lon}'` — the API rejects requests without
  Body/MediaUrl, error 21602), buttons → numbered text fallback
  appended to Body (native buttons need pre-registered Content Templates — out of
  scope v0.1, documented), `replyTo` → skipped with debug log (no API support).
  Non-2xx → throw with status + body; `SendResult.id` = response `sid`.
- `sendTyping`/`markRead`: NOT implemented (omit the optional methods — Twilio does not
  expose them for WhatsApp; Bot feature-detects absence).
- `start` with `port` → own node:http server via handleRequest (404 others); without
  `port` → validate config only (user mounts handleRequest). `stop` idempotent.

Tests (offline, mirroring cloud-api's): signature validation accept/reject/missing +
the sorted-params algorithm against a fixture computed with node:crypto; TwiML 200
response; status-callback skip; dedup on redelivered MessageSid; mapping fixtures
(text, button reply, media incl. download via a fake Twilio server with auth asserted,
location, reaction, quoted); send body construction (prefix handling, media URL,
Buffer throws, location PersistentAction, buttons fallback, non-2xx throws);
handleRequest rawBody param path; lifecycle. Run against a real ephemeral node:http
server + fake Twilio API as apiBaseUrl.

Docs: docs/transports/twilio.md — sandbox quickstart (join code), production sender
setup, webhookUrl/proxy caveat, the 24-hour session window + template limitation,
capability table vs the other transports (no buttons, no typing, no read receipts,
URL-only outbound media).

create-wappa-agent: `--transport` gains `twilio` (deps @wappajs/core + @wappajs/twilio +
provider; .env.example: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER,
PORT; README documents the sandbox flow).

---

# @wappajs/anthropic

Deps: `@anthropic-ai/sdk@^0.123.0`, `@wappajs/core`. Verify against installed SDK types.

```ts
export interface AnthropicProviderOptions {
  apiKey?: string;               // default env ANTHROPIC_API_KEY (SDK default)
  model?: string;                // default 'claude-sonnet-5'
  /** Extra options passed to the Anthropic CLIENT CONSTRUCTOR (baseURL, timeout, ...). */
  clientOptions?: ConstructorParameters<typeof Anthropic>[0];
}
export class AnthropicProvider implements Provider { readonly name: 'anthropic'; }
```

Mapping (`generate`):
- `system` → `system`; maxTokens → `max_tokens` (required by API — default 1024 if unset).
- history: user → `{role:'user', content}`; assistant with toolCalls →
  content blocks `[{type:'text'} if content, ...{type:'tool_use', id, name, input}]`;
  'tool' messages → user message with `tool_result` blocks (consecutive tool messages
  merge into ONE user message, in order, `tool_use_id` = toolCallId).
- tools → `[{ name, description, input_schema: parameters }]`.
- Response: concatenate text blocks → text (null if none); tool_use blocks → toolCalls;
  stop_reason `end_turn`→'stop', `tool_use`→'tool_calls', `max_tokens`→'length',
  else 'other'. usage from response.usage.
- TEMPERATURE GATE: sampling params are removed (400) on claude-fable-5 / claude-mythos-5 /
  claude-opus-5 / claude-opus-4-7 / claude-opus-4-8 / claude-sonnet-5 (prefix match) —
  drop `temperature` with a once-per-instance warn for those; forward it for
  claude-opus-4-6 / claude-sonnet-4-6 and older.
- NO-TOOLS FALLBACK: when req.tools is undefined/empty but the history carries
  toolCalls/tool messages (the Agent's maxTurns-exhaustion call), degrade tool blocks to
  plain text (`[called name(args)]` / `[name result] …`) — the API 400s on tool blocks
  without a tools param.
- Empty-string tool results omit the tool_result `content` key (empty text blocks 400).

Tests: mapping functions exported separately (`toAnthropicMessages`, `fromAnthropicResponse`)
and unit-tested; provider itself tested with an injected fake client.

---

# @wappajs/openai

Deps: `openai@^7.9.0`, `@wappajs/core`. Verify against installed SDK types. Use the **Chat
Completions** API (max compatibility incl. OpenAI-compatible local servers).

```ts
export interface OpenAIProviderOptions {
  apiKey?: string;               // default env OPENAI_API_KEY
  model?: string;                // default 'gpt-5'
  baseURL?: string;              // for Ollama/compatible servers
  /**
   * Reasoning effort for reasoning-family models (gpt-5*, o1*/o3*/o4*, excluding
   * *-chat-latest): sent as reasoning_effort, default 'low' — hidden reasoning tokens
   * count against max_completion_tokens and would otherwise starve short maxTokens
   * budgets into empty replies. Never sent for non-reasoning models.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Extra options passed to the OpenAI CLIENT CONSTRUCTOR. */
  clientOptions?: ConstructorParameters<typeof OpenAI>[0];
}
export class OpenAIProvider implements Provider { readonly name: 'openai'; }
```

Mapping: system → first message role 'system'; assistant toolCalls →
`tool_calls: [{id, type:'function', function:{name, arguments: JSON.stringify}}]`;
'tool' → `{role:'tool', tool_call_id, content}`. tools →
`[{type:'function', function:{name, description, parameters, strict:false}}]`.
Response: choice.message.content/tool_calls (parse arguments JSON — on parse failure use
`{}` and log), finish_reason `stop`→stop, `tool_calls`→tool_calls, `length`→length.
maxTokens is sent as `max_completion_tokens` (gpt-5-class models reject `max_tokens`).
TEMPERATURE GATE: reasoning-family models (gpt-5*, o1*/o3*/o4*, excluding *-chat-latest)
reject non-default temperature — drop it with a once-per-instance warn; forward for
everything else (gpt-4o, *-chat-latest, custom baseURL models). Warn on every
finishReason 'length' + null-text result (reasoning starvation is silent otherwise).
Same test strategy as anthropic (exported mapping fns + fake client).

---

# create-wappa-agent

Zero-dependency scaffolder run via `npm create wappa-agent my-bot`. `bin` → `dist/index.js`
with shebang. Interactive prompts via `node:readline/promises` (skippable with flags):
`--transport baileys|cloud-api`, `--provider anthropic|openai`, `--yes`.

Generates: package.json (deps: @wappajs/core + chosen transport + chosen provider pinned to
the same version as the CLI), tsconfig, src/index.ts wired for the chosen combo
(reads env vars, .env.example included), .gitignore, README with run instructions.
Templates live in `templates/` as plain text files with `__PLACEHOLDER__` substitution and
ship in the package (`files` includes `templates`). Do NOT run npm install for the user;
print next steps. Test: run the built CLI with flags in a tmp dir, assert generated
package.json/index.ts contents.

---

# Examples

Each is a workspace package (`private: true`) with a `start` script using `tsx`? No —
avoid extra deps: build with tsc like everything else, `npm start` = `node dist/index.js`,
plus a `dev` script `node --watch`. Keep each under ~120 lines, heavily commented.

1. **echo-bot**: no LLM. `bot.command('/ping')`, `hears`, echo middleware. Uses
   BaileysTransport by default with a comment showing MockTransport usage for tests.
2. **support-agent** (flagship): AnthropicProvider + BaileysTransport. Tools:
   `check_order_status` (fake DB lookup), `escalate_to_human` (sets
   `ctx.session.paused = true` — the in-pipeline form — and notifies an operator chat id
   from env via `ctx.bot.send` — the interpolated push name is sanitized: control chars
   stripped, 64-char cap, chatId on its own line). `/resume <chatId>` command for the
   operator (uses `ctx.state.commandArgs`, calls `bot.resume`) — FAILS CLOSED: disabled
   entirely (startup warning) when OPERATOR_CHAT_ID is unset. Rate limit middleware.
   Shows instructions-as-function (injects customer name/time).
3. **cloud-api-agent**: OpenAIProvider + CloudApiTransport with `port`, .env.example
   documenting Meta dashboard setup, one `get_weather` demo tool.

---

# Root files

- Root `package.json`: private, workspaces `["packages/*", "examples/*"]`, scripts:
  `build` = `tsc -b`, `test` = `vitest run`, `clean`. devDeps: typescript, vitest,
  @types/node.
- `tsconfig.base.json`: strict, ES2022 target/lib, module NodeNext, moduleResolution
  NodeNext, declaration, declarationMap, sourceMap, composite, isolatedModules,
  skipLibCheck (baileys types need it), noUncheckedIndexedAccess, exactOptionalPropertyTypes: false (pragmatic — optional-prop assignment friction not worth it).
- Root `tsconfig.json`: `files: []`, references to every package + example.
- Per-package `tsconfig.json`: extends base, rootDir src, outDir dist, include src,
  exclude tests; `references` to @wappajs/core where applicable.
- Workspace deps: use `"@wappajs/core": "^0.1.0"` (npm workspaces links it locally and it
  stays publishable). All packages version `0.1.0`.
- `.gitignore`: node_modules, dist, *.tsbuildinfo, wappa-auth, .env, and BOTH session
  dir names (`sessions/`, `.wappa-sessions/`) — session files are customer PII.
- LICENSE: MIT.

# Non-goals for v0.1 (document in README roadmap)

Streaming replies, WhatsApp flows/forms, voice transcription (recipe shows how via a
middleware), scheduled/cron messages (recipe with plain setInterval), group mention
filtering (recipe using bot.selfId), analytics, admin UI, Redis session store.

# Legal note (must appear in README + baileys docs)

Baileys is an unofficial client: using it may violate WhatsApp's ToS and can get numbers
banned; use a number you can afford to lose, prefer the Cloud API for production.
