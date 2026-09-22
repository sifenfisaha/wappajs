# Concepts

How the pieces of `@wappajs/core` fit together: the `Bot` pipeline, the `Agent` loop,
tools, sessions, middleware, and pause/handoff.

## Bot

`Bot` wires a `Transport` to your middleware, routes, and an optional `Agent`:

```ts
const bot = new Bot({
  transport,                 // required: any Transport implementation
  agent,                     // optional: router-only bots are valid
  sessions,                  // default: new MemorySessionStore()
  ignoreFromMe: true,        // default true: drop messages sent by the bot's own number
  ignoreGroups: false,       // default false
  allowFrom: ['15551234567'],// optional allowlist of senderIds; others silently dropped
  logger,                    // default consoleLogger() ('info' level)
  onError,                   // default: logger.error
  typingIndicator: true,     // default true: best-effort typing indicator while the agent thinks
});
```

### The pipeline, in exact order

For each inbound message:

1. **Drop filters.** The message is dropped (nothing runs) if: `fromMe` and
   `ignoreFromMe`; or `isGroup` and `ignoreGroups`; or `allowFrom` is set and the
   `senderId` is not in it; or the bot is stopping/stopped.
2. **Per-chat queue.** The message is enqueued on a promise chain keyed by `chatId`:
   messages within one chat are processed strictly sequentially, while different chats
   run concurrently. The queue entry is pruned when it drains.
3. **Session + Context.** The session is loaded from the store (or `createSession()` for
   a new chat) and a `Context` is built. The context is registered as the chat's live
   in-flight context until step 5 completes (this matters for `pause`/`resume`, see
   below).
4. **Middleware chain**, in `use()` registration order, with the **built-in router** as
   the innermost handler:
   1. If `session.paused` → stop. No routing, no agent (middleware already ran).
   2. If the message has no `text` (reaction-only, media without caption, location-only,
      …) → skip routing and the agent entirely. Middleware still ran, and observation
      middleware is the way to react to these.
   3. First matching `command()`, else first matching `hears()` → run its handler; done.
   4. Else, if an `agent` is configured: send the typing indicator (when enabled), run
      `agent.run(ctx)`, and `ctx.reply(text)` if the agent returned text; finally clear
      the typing indicator. The typing indicator is **best-effort in both directions**:
      a transport typing failure is debug-logged and never aborts the turn.
   5. Else: do nothing.
5. **Save session.** `session.updatedAt = Date.now()`, then `sessions.set(...)`. The
   session is saved **even when step 4 threw**. Whatever consistent state the pipeline
   left behind is persisted.
6. **Errors** anywhere in the pipeline go to `onError(err, ctx)`; they never crash the
   process or the queue.

### Routing

```ts
bot.command('/reset', async (ctx) => {
  ctx.session.history = [];
  await ctx.reply('Conversation cleared.');
});

bot.command('resume', handler); // missing '/' is normalized: 'resume' === '/resume'

bot.hears('menu', handler);        // exact trimmed match, case-insensitive, NOT substring
bot.hears(/order #(\d+)/i, handler); // RegExp: tested against the raw text
```

Command matching is case-insensitive after trimming leading whitespace: the text must
equal the command, or start with the command followed by whitespace. `/reset` matches
`/reset` and `/reset now`, never `/resetall`. Before invoking the handler, the router
sets `ctx.state.commandArgs` to the trimmed remainder (`''` if none):

```ts
bot.command('/resume', async (ctx) => {
  const chatId = ctx.state.commandArgs as string; // '' when no argument was given
  await ctx.bot.resume(chatId);
});
```

A string `hears()` pattern matches when the **whole trimmed text** equals it
case-insensitively (Telegraf-style exact trigger). Use a RegExp for anything fuzzier.

### Lifecycle events

`on()` is for transport lifecycle only. Message handling belongs to
`use()`/`command()`/`hears()`/agent:

```ts
bot.on('ready', (info) => console.info('connected as', info.selfId));
bot.on('error', (err) => { /* transport-level errors */ });
bot.on('disconnect', (reason) => { /* e.g. 'loggedOut' on Baileys */ });
```

`bot.selfId` is set once the transport reports ready. Pipeline errors go to the
`onError` option, not the `'error'` event (that one carries transport errors).

### Start, stop, proactive sends

- `bot.start()` starts the transport and begins processing.
- `bot.stop()` is a graceful shutdown: new inbound messages are dropped, all per-chat
  queues drain (in-flight turns finish and their sessions save), then the transport
  stops. Idempotent.
- `bot.send(chatId, content)` sends proactively any time after start, with no inbound
  message required.

## Context

Every middleware, route handler, and tool receives the same per-message `Context`:

```ts
interface Context {
  message: InboundMessage;     // the normalized inbound message
  bot: Bot;                    // for bot.send, bot.pause/resume, bot.selfId
  session: SessionData;        // loaded session, mutate freely; Bot saves it after the pipeline
  state: Record<string, unknown>; // per-message scratch space; NOT persisted
  reply(content): Promise<SendResult>;  // send to message.chatId
  sendTyping(on?): Promise<void>;       // no-op if the transport lacks it; default on=true
  logger: Logger;
}
```

### `ctx.session.data` vs `ctx.state`

- `ctx.session.data` is **durable**: an arbitrary record persisted across messages by
  the session store. Put user preferences, collected form fields, escalation metadata
  here.
- `ctx.state` is **ephemeral**: per-message scratch space that dies with the pipeline
  run. Middleware uses it to pass values downstream (the router itself uses it for
  `ctx.state.commandArgs`).

## Sessions

```ts
interface SessionData {
  history: ChatMessage[];          // conversation memory the Agent maintains
  data: Record<string, unknown>;   // your durable per-chat data
  paused?: boolean;                // human-handoff flag: true = router + agent skipped
  updatedAt: number;
}
```

Two stores ship with core, both implementing the three-method `SessionStore` interface
(`get`/`set`/`delete`, all promise-based):

- `MemorySessionStore`: Map-backed, the default. Not durable across restarts.
- `FileSessionStore(dir)`: one JSON file per chat under `dir` (chatId sanitized with
  `encodeURIComponent`), written atomically via tmp-file + rename. `get()` returns
  `undefined` for a missing file **and** for unparseable JSON, so a corrupt file can
  never permanently brick a chat. The next save overwrites it.

```ts
import { FileSessionStore } from '@wappajs/core';
const bot = new Bot({ transport, agent, sessions: new FileSessionStore('.wappa-sessions') });
```

## Middleware

Koa/grammY-style: `(ctx, next)` functions run in registration order around the built-in
router. Not calling `next()` stops the chain, router included. Calling `next()` twice
throws `Error('next() called multiple times')`.

```ts
bot.use(async (ctx, next) => {
  const started = Date.now();
  await next(); // everything downstream, including the router/agent
  ctx.logger.info('handled', { chatId: ctx.message.chatId, ms: Date.now() - started });
});
```

Core ships one middleware factory, `rateLimit`, a fixed-window counter per chat:

```ts
import { rateLimit } from '@wappajs/core';

bot.use(rateLimit({
  windowMs: 60_000, // default
  max: 20,          // default: 20 messages per window per chat
  onLimit: (ctx) => ctx.reply('Slow down a little, try again in a minute.'),
}));
```

Over-limit messages are dropped: `onLimit` is called (awaited; errors go to
`ctx.logger`) and `next()` is **not** called, so neither routes nor the agent run.

## Tools

`defineTool` turns a definition into a `Tool` the agent loop can call. With a zod
schema, argument types are inferred end-to-end:

```ts
import { defineTool } from '@wappajs/core';
import { z } from 'zod';

const checkOrder = defineTool({
  name: 'check_order_status', // must match ^[a-zA-Z0-9_-]{1,64}$ (validated eagerly)
  description: 'Look up the status of an order by its id.',
  parameters: z.object({ orderId: z.string().describe('The order id, e.g. A-1001') }),
  async execute({ orderId }, ctx) {
    // args are typed { orderId: string }; ctx is the full per-message Context
    return { orderId, status: 'shipped' };
  },
});
```

`parameters` may also be a raw JSON Schema object (args are then
`Record<string, unknown>`), or omitted entirely (schema defaults to
`{ type: 'object', properties: {} }`). Zod schemas are converted with
`z.toJSONSchema` before being handed to the provider.

`invoke` (what the agent loop calls) never throws:

- zod validation failure → the validation error is **returned as the tool result
  string** (`Error: invalid arguments for tool "…": …`) so the model can retry;
- `execute` results are stringified: strings pass through, `null`/`undefined` → `"ok"`,
  objects/arrays → `JSON.stringify`, other primitives → `String(value)`;
- thrown errors → `"Error: <message>"` as the result string. A failing tool never
  crashes the agent loop.

## Agent

```ts
const agent = new Agent({
  instructions,           // string, or (ctx) => string | Promise<string>, re-evaluated per message
  knowledge,              // optional: the half of the prompt that never changes, cached where possible (see below)
  provider,               // AnthropicProvider, OpenAIProvider, or your own
  tools: [checkOrder],    // optional
  maxTurns: 8,            // default: max provider round-trips per inbound message
  maxHistoryMessages: 40, // default: history window (ChatMessages kept in session)
  maxHistoryChars: 200_000, // default: cap on total history content chars (see below)
  maxTokens: 1024,        // default
  temperature: 0.7,       // omitted from requests unless set (and some models drop it,
                          // see providers.md)
});
```

`agent.run(ctx)` executes one agentic turn. It does **not** send the reply (the Bot
does) and does **not** persist the session (also the Bot's job):

1. **Render the user message** from the inbound and append it to
   `ctx.session.history`: the text if present; media-only messages become a
   `[image]`/`[voice note]`/`[video]`/… placeholder (plus the caption when there is
   one); a location becomes `[location: lat, lon]`. In groups, the body is prefixed
   with `senderName || senderId` + `: ` so the model knows who is speaking.
2. **Loop** (up to `maxTurns` times): call `provider.generate()` with the system
   prompt, the windowed history, and the tool specs.
   - If the model returned no tool calls, its text is the final answer, so stop.
   - Otherwise append the assistant message (with its `toolCalls`, and whatever
     `providerData` the provider returned, so it can replay its own turn exactly, see
     the [provider contract](providers.md#writing-a-custom-provider)) and execute each
     requested call **sequentially** via `tool.invoke(args, ctx)`, appending one
     `role: 'tool'` message per call.
   - A requested tool name that is not registered does not throw: the tool result is
     `Error: unknown tool <name>` and the loop continues, same as a failing tool.
3. **maxTurns escape hatch.** If the cap is hit while the model still wants tools, one
   final `generate()` runs **without tools** to force a text answer.
4. **Final assistant message** is appended only if the text is non-null and non-empty.
   Invariant: history never contains an assistant message with empty content and no
   toolCalls (the Anthropic API rejects those on the next turn).
5. **History windowing.** History is trimmed to `maxHistoryMessages`, and the window is
   aligned forward to the next `user` message, so **the window always opens with a user
   message** (providers reject histories that start with an assistant or tool message).
   That alignment also keeps assistant-toolCalls/tool-results groups whole. A group at
   the window edge is dropped, never split. If aligning would empty the window (e.g. one
   tool group larger than the whole window), the slice **falls back to the last user
   message** in history, so every request still carries the current user turn. A second
   cap, `maxHistoryChars` (default `200_000` total content chars), then drops the
   **oldest whole user-turn group** while over budget, always keeping at least the
   final user message, so one huge pasted message can't permanently exceed the model
   context (failed turns roll back, so an oversized window would otherwise be retried
   forever). The same windowing is applied to what is sent to the provider on every
   call.
6. **Error rollback.** If `generate` or the loop throws, `ctx.session.history` is
   restored to its pre-run snapshot before the error propagates. A failed turn is never
   persisted (the Bot still saves the session afterwards, now containing the rolled-back
   history).

`run` returns the final text, or `null` when the model produced none (in which case the
Bot sends nothing).

### Knowledge: the half of the prompt that does not change

A real agent's system prompt is mostly material that is the same on every message: the
policy, the product catalogue, the FAQ, the price list. Only a few lines change from one
message to the next: the time, who is writing, what state the chat is in. `knowledge` is
where the stable material goes, and `instructions` is where the rest goes:

```ts
const agent = new Agent({
  knowledge: () => catalogue.render(),   // long, and identical from one message to the next
  instructions: (ctx) =>                  // short, and different every time
    `Now: ${new Date().toISOString()}. Customer: ${ctx.message.senderName ?? 'unknown'}.`,
  provider: new AnthropicProvider(),
});
```

The agent sends the provider the knowledge first, then the instructions, as one `system`
string, and alongside it the same prompt split in two (`GenerateRequest.systemParts`). A
provider that supports prompt caching caches the stable part: `@wappajs/anthropic` puts a
cache breakpoint after it, so every message of every chat reads the knowledge from the
cache, at a tenth of the input price and without the latency of the model re-reading it.
A provider that cannot cache ignores the split and uses `system`, which is what OpenAI's
automatic prefix caching wants as well: the stable bytes first.

Two rules keep the cache warm. Put every stable byte in `knowledge` and nothing volatile,
since a timestamp in the knowledge invalidates the cache on every message. And note that
the function form is re-evaluated per message like `instructions`, so it can be rebuilt
from a database as often as you like; the cache holds for as long as the text comes back
identical.

## Pause and handoff

`session.paused` is the human-handoff flag: while `true`, the router and agent are
skipped for that chat (middleware still runs), so a human can converse from the linked
phone/dashboard without the bot interfering.

Three ways to flip it, all lost-update safe:

```ts
// 1. Inside a handler or tool for the CURRENT chat, the most direct form:
ctx.session.paused = true;                 // Bot's own pipeline save persists it

// 2. From anywhere, for any chat:
await bot.pause(chatId);
await bot.resume(chatId);
```

`bot.pause`/`bot.resume` never do a naive independent load→mutate→save (that would race
the pipeline's own save and deterministically lose one of the two writes with any store
that returns copies, e.g. `FileSessionStore`). Instead:

- If the chat has a **live in-flight context** (its pipeline is currently running, the
  common case when a tool calls `ctx.bot.pause(ctx.message.chatId)`), the live
  `ctx.session.paused` is mutated directly and the pipeline's save persists it. This
  deliberately does not enqueue on the per-chat queue. The current turn holds it, and
  enqueueing would deadlock.
- Otherwise, a load→mutate→save job is enqueued on the chat's per-chat queue so it
  serializes with message processing.

See [recipes.md](recipes.md#human-handoff) for a complete escalation flow.
