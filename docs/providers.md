# Providers

A provider is the LLM half of the contract: the core owns the tool-call loop and
conversation memory, and a provider maps **one** `generate()` call to its SDK. Two ship
with wappa; writing your own is a single method.

## `@wappajs/anthropic`: Claude

```ts
import { AnthropicProvider } from '@wappajs/anthropic';

const provider = new AnthropicProvider({
  apiKey: '...',              // default: ANTHROPIC_API_KEY env var (SDK default)
  model: 'claude-sonnet-5',   // default
  effort: 'medium',           // optional: output_config.effort; the API default is 'high'
  thinking: { type: 'adaptive' }, // optional: the `thinking` param, passed through as given
  extraParams: {},            // optional: merged into every request last (metadata, stop_sequences, ...)
  clientOptions: {            // extra options for the Anthropic CLIENT CONSTRUCTOR
    // baseURL, timeout, maxRetries, defaultHeaders, ...
  },
  logger,                     // adapter diagnostics (e.g. dropped sampling params); default consoleLogger()
});
```

All options are optional. `new AnthropicProvider()` works with the env var set.

Mapping notes (all handled for you):

- `system` travels as the API's top-level `system` param; `maxTokens` → `max_tokens`
  (the API requires it, 1024 when unset).
- **The agent's `knowledge` is cached.** When the agent has [`knowledge`](concepts.md#knowledge-the-half-of-the-prompt-that-does-not-change),
  the system prompt is sent as two text blocks with a cache breakpoint after the stable
  one. The API caches the prefix up to the breakpoint (the tools, then the knowledge),
  so from the second call on, every message of every chat reads it from the cache at
  about a tenth of the input price. Nothing to configure; keep volatile text out of the
  knowledge and the cache stays warm.
- **Thinking blocks are kept and replayed.** The current models think before they
  answer, and inside a tool loop the API requires the thinking block of the
  tool-calling turn to come back unchanged, or the next call is rejected. The provider
  keeps the content blocks of every turn that holds more than text on the assistant
  message's `providerData` (the Agent stores it with the history, session stores
  persist it) and replays them, rebuilt with request fields only, on the next call.
  Nothing to configure here either.
- `effort` → `output_config.effort`. The API default is `'high'`; a chat assistant
  is usually better served at `'low'` or `'medium'`, which answer in seconds and cost
  less. `thinking` is passed through as given, for models that leave thinking off by
  default (`{ type: 'adaptive' }`) or to turn it off where a model allows that.
- `extraParams` is merged into every request after the provider's own fields: the
  escape hatch for Messages API parameters the provider does not model. A beta feature
  needs its header too, which goes through the client:

  ```ts
  new AnthropicProvider({
    extraParams: { fallbacks: 'default' },
    clientOptions: { defaultHeaders: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } },
  });
  ```
- `temperature` is forwarded only when set **and** the model still supports it. The
  current model generation, covering `claude-fable-5`, `claude-mythos-5`, `claude-opus-5`,
  `claude-opus-4-7`, `claude-opus-4-8`, and `claude-sonnet-5` (the default), has
  sampling params (`temperature`/`top_p`/`top_k`) **removed from the API** (sending
  them returns 400), so for those models the provider drops `temperature` and warns
  once per instance. `claude-opus-4-6`, `claude-sonnet-4-6` and older models (the 4.5
  family, haiku) still receive it.
- Assistant messages with tool calls become `text` + `tool_use` content blocks; wappa's
  `role: 'tool'` messages become `tool_result` blocks, with **consecutive tool messages
  merged into one user message** (as the Messages API expects).
- When a request carries **no tools** but the history contains tool calls/results, which is
  the agent's maxTurns-exhaustion fallback call, the tool blocks are degraded to
  plain text (`[called <tool>({...})]` assistant lines, `[<tool> result] …` user
  lines), because the Messages API rejects `tool_use`/`tool_result` blocks without a
  `tools` param.
- Response text blocks are concatenated (`null` if none); `tool_use` blocks become
  wappa `ToolCall`s; `stop_reason` maps `end_turn` → `stop`, `tool_use` → `tool_calls`,
  `max_tokens` → `length`, anything else → `other`. Token usage is reported on
  `GenerateResult.usage`.
- A turn the model refuses (`stop_reason: 'refusal'`) comes back with no text and is
  logged at warn level with its `stop_details`; the Bot then sends nothing for that
  message. Handle it upstream if silence is not what you want.

## `@wappajs/openai`: GPT and OpenAI-compatible servers

Built on the **Chat Completions** API for maximum compatibility, including local
OpenAI-compatible servers.

```ts
import { OpenAIProvider } from '@wappajs/openai';

const provider = new OpenAIProvider({
  apiKey: '...',        // default: OPENAI_API_KEY env var (SDK default)
  model: 'gpt-5',       // default
  baseURL: '...',       // point at any OpenAI-compatible server
  reasoningEffort: 'low', // reasoning models only; default 'low', see below
  clientOptions: { /* timeout, fetch, ..., apiKey/baseURL above win on conflict */ },
  logger,               // diagnostics (malformed tool-call args, dropped params,
                        // exhausted budgets); default consoleLogger()
});
```

Mapping notes:

- `system` becomes the first message with role `'system'`; tool calls round-trip through
  `tool_calls` with JSON-stringified arguments; wappa `'tool'` messages become
  `{ role: 'tool', tool_call_id, content }`.
- Tools are sent as function tools with `strict: false` (wappa schemas come from zod or
  raw JSON Schema and aren't guaranteed to satisfy structured-output restrictions).
- The token limit is sent as `max_completion_tokens` (the current parameter, required by
  reasoning-capable models like the default `gpt-5`).
- **Reasoning-family models**: `gpt-5*` and the o-series (`o1*`/`o3*`/`o4*`), excluding
  the `*-chat-latest` variants (those behave like regular chat models), reject
  non-default `temperature` with 400, so the provider **drops `temperature`** for them
  and warns once per instance. All other models (`gpt-4o`, `*-chat-latest`, custom
  `baseURL` models) receive it unchanged.
- For reasoning-family models the provider also sends `reasoning_effort` (the
  `reasoningEffort` option: `'minimal' | 'low' | 'medium' | 'high'`, default `'low'`):
  the API's default effort can burn the whole `max_completion_tokens` budget on hidden
  reasoning tokens and return an empty response. It is never sent for non-reasoning
  models, since some OpenAI-compatible servers reject unknown params.
- When a response comes back with `finishReason 'length'` and **no text**, the provider
  logs a warning that the completion budget was exhausted before any output. Raise
  `maxTokens` (the agent's default is 1024).
- Tool-call `arguments` that aren't valid JSON (or aren't an object) fall back to `{}`
  with a logged warning, so the loop keeps running and the tool's own validation answers.
- `finish_reason`: `stop` → `stop`, `tool_calls` → `tool_calls`, `length` → `length`,
  anything else → `other`.

### Ollama and friends via `baseURL`

Any server that speaks Chat Completions works: Ollama, vLLM, llama.cpp server, LM
Studio, …:

```ts
const provider = new OpenAIProvider({
  baseURL: 'http://localhost:11434/v1', // Ollama's OpenAI-compatible endpoint
  apiKey: 'ollama',                     // Ollama ignores it, but the SDK wants one
  model: 'llama3.1',
});
```

Pick a model that supports tool calling if your agent has tools.

## Writing a custom provider

Implement the `Provider` interface from `@wappajs/core`, one readonly name and one method:

```ts
import type {
  ChatMessage,      // { role: 'user'|'assistant'|'tool', content, toolCalls?, toolCallId?, toolName? }
  GenerateRequest,  // { system?, systemParts?, messages, tools?, maxTokens?, temperature? }
  GenerateResult,   // { text, toolCalls, finishReason, usage?, providerData? }
  Provider,
  ToolCall,         // { id, name, arguments: Record<string, unknown> }
  ToolSpec,         // { name, description, parameters: JsonSchema }
} from '@wappajs/core';

export class MyProvider implements Provider {
  readonly name = 'my-provider';

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    // 1. Map req.system + req.messages + req.tools to your API's shape.
    // 2. Make ONE non-streaming call.
    // 3. Map the response back:
    return {
      text: 'Hello!',        // final assistant text, or null if the model only called tools
      toolCalls: [],         // requested ToolCalls, [] if none
      finishReason: 'stop',  // 'stop' | 'tool_calls' | 'length' | 'other'
      usage: { inputTokens: 12, outputTokens: 5 }, // optional
    };
  }
}
```

The contract, in full:

- `GenerateRequest.system` is the system prompt. There is **no** `system` role in
  `ChatMessage`; every provider treats the system prompt specially, so it travels
  separately.
- `messages` is the windowed history. Roles are `'user'`, `'assistant'` (which may carry
  `toolCalls`), and `'tool'` (one per executed call, carrying `toolCallId` and
  `toolName`, with the stringified result in `content`). Assistant `content` may be
  `''` when the model only called tools.
- `tools` (when present) are `ToolSpec`s whose `parameters` is a JSON Schema object,
  map them to your API's tool/function format.
- `systemParts` is present when the agent has `knowledge`: `{ stable, dynamic }`, the
  same text as `system` in two pieces. Use it if your API can cache a prompt prefix;
  ignore it otherwise, `system` already carries both in the right order.
- `providerData` is yours: return whatever you need to replay an assistant turn exactly
  (thinking blocks, reasoning items, signatures) on `GenerateResult`, and the Agent
  stores it on the assistant message it appends, so it comes back to you on that message
  in `messages` next call. It must be JSON-serializable, because session stores persist
  it. Leave it out when your API needs nothing.
- Return `text: null` (not `''`) when the model produced no text, and every requested
  call as a `ToolCall` with `arguments` as a plain object (parse if your API sends
  JSON strings; fall back to `{}` rather than throwing).
- Don't loop, don't execute tools, don't touch sessions. The `Agent` does all of that.
  Throwing is fine: the agent rolls the turn back and the Bot reports it via `onError`.

Test it the same way the built-ins are tested: pure mapping functions plus an injected
fake client, or just run it under the `Agent` with `MockTransport`
(see [testing.md](testing.md)).
