/**
 * Pure mapping between wappa's provider-agnostic chat model and the Anthropic
 * Messages API. No I/O — these functions are unit-tested against fixtures.
 */
import type { Anthropic } from '@anthropic-ai/sdk';
import type { ChatMessage, GenerateResult, SystemParts, ToolCall, ToolSpec } from '@wappajs/core';

/** The `system` + `messages` slice of an Anthropic `messages.create` request. */
export interface AnthropicMessagesParams {
  /** System prompt; omitted entirely when the request has none. */
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
}

/**
 * The system prompt as the API takes it. A plain string when the agent has no
 * knowledge; otherwise the stable part as a text block carrying a cache
 * breakpoint, followed by the dynamic part. The API caches the prefix up to the
 * breakpoint — the tools and the stable block — so every message of every chat
 * reads the knowledge from the cache instead of paying for it again. An empty
 * stable part falls back to the plain string: the API rejects empty text blocks.
 */
export function toAnthropicSystem(
  system: string | undefined,
  parts: SystemParts | undefined,
): string | Anthropic.TextBlockParam[] | undefined {
  if (!parts || !parts.stable) return system;
  const blocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: parts.stable, cache_control: { type: 'ephemeral' } },
  ];
  if (parts.dynamic) blocks.push({ type: 'text', text: parts.dynamic });
  return blocks;
}

/**
 * The content blocks an assistant message was produced with, when the message
 * carries them — put there by {@link fromAnthropicResponse}. Anything else on
 * `providerData` (another provider's data, a hand-written session) is ignored and
 * the message is rebuilt from its text and tool calls instead.
 */
function replayBlocks(msg: ChatMessage): Anthropic.ContentBlock[] | undefined {
  const data = msg.providerData;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const isBlock = (b: unknown): b is Anthropic.ContentBlock =>
    typeof b === 'object' && b !== null && typeof (b as { type?: unknown }).type === 'string';
  return data.every(isBlock) ? data : undefined;
}

/**
 * Turn the content blocks of a response into the content blocks of a request.
 *
 * The response shapes carry fields the request schema does not accept —
 * `citations: null` on a text block, `caller` on a tool_use block — and the API
 * rejects unknown fields, so each known block is rebuilt with only its request
 * fields. Thinking blocks go back exactly as they came: the API checks their
 * signature, and a turn that used tools cannot be continued without them. Empty
 * text blocks are dropped (the API rejects those too). Anything else passes
 * through as it came.
 */
export function toReplayBlocks(blocks: Anthropic.ContentBlock[]): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text) out.push({ type: 'text', text: block.text });
        break;
      case 'tool_use':
        out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        break;
      case 'thinking':
        out.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
        break;
      case 'redacted_thinking':
        out.push({ type: 'redacted_thinking', data: block.data });
        break;
      default:
        out.push(block as unknown as Anthropic.ContentBlockParam);
    }
  }
  return out;
}

/**
 * Convert wappa history to Anthropic request messages.
 *
 * - `user` messages pass through with string content.
 * - `assistant` messages that carry the blocks they were produced with (see
 *   {@link fromAnthropicResponse}) are replayed from those blocks, via
 *   {@link toReplayBlocks}, so thinking blocks come back intact.
 * - Other `assistant` messages with `toolCalls` become content blocks:
 *   a `text` block (only when content is non-empty) followed by one
 *   `tool_use` block per call.
 * - Consecutive `tool` messages merge into ONE `user` message of
 *   `tool_result` blocks, in order, with `tool_use_id` = `toolCallId`.
 *   An empty-string tool result omits the `content` key entirely — the API
 *   rejects an empty text block.
 * - `system` travels separately (the API takes it as a top-level param), split
 *   for caching when `parts` is given (see {@link toAnthropicSystem}); the key
 *   is omitted when undefined.
 */
export function toAnthropicMessages(
  system: string | undefined,
  messages: ChatMessage[],
  parts?: SystemParts,
): AnthropicMessagesParams {
  const out: Anthropic.MessageParam[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === 'tool') {
      const blocks: Anthropic.ToolResultBlockParam[] = [];
      while (i < messages.length && messages[i]!.role === 'tool') {
        const toolMsg = messages[i]!;
        const block: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: toolMsg.toolCallId ?? '',
        };
        // The API rejects an empty text block; omit content for '' results.
        if (toolMsg.content !== '') block.content = toolMsg.content;
        blocks.push(block);
        i++;
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (msg.role === 'assistant') {
      const replay = replayBlocks(msg);
      if (replay) {
        const content = toReplayBlocks(replay);
        if (content.length > 0) {
          out.push({ role: 'assistant', content });
          i++;
          continue;
        }
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
        if (msg.content) blocks.push({ type: 'text', text: msg.content });
        for (const call of msg.toolCalls) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
        }
        out.push({ role: 'assistant', content: blocks });
        i++;
        continue;
      }
    }
    out.push({ role: msg.role, content: msg.content });
    i++;
  }
  const params: AnthropicMessagesParams = { messages: out };
  const sys = toAnthropicSystem(system, parts);
  if (sys !== undefined) params.system = sys;
  return params;
}

/**
 * Degrade tool-call history to plain text for a request made WITHOUT tools.
 *
 * The Messages API rejects `tool_use`/`tool_result` blocks when the request
 * carries no `tools` param (400), which broke the agent's maxTurns-exhaustion
 * fallback (a final generate without tools over tool-bearing history). Each
 * assistant `toolCalls` entry becomes text `[called <name>(<compact json
 * args>)]` appended to the assistant text; each `tool` message becomes a plain
 * user text message `[<toolName> result] <content>`. Ordering is preserved and
 * no tool blocks remain. The degraded assistant messages lose their
 * `providerData` with the tool blocks it held; text-only messages keep theirs.
 */
export function degradeToolHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: string[] = msg.content ? [msg.content] : [];
      for (const call of msg.toolCalls) {
        parts.push(`[called ${call.name}(${JSON.stringify(call.arguments)})]`);
      }
      return { role: 'assistant', content: parts.join('\n') };
    }
    if (msg.role === 'tool') {
      return { role: 'user', content: `[${msg.toolName ?? 'tool'} result] ${msg.content}` };
    }
    return msg;
  });
}

/** Convert wappa tool specs to Anthropic tool definitions. */
export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool['input_schema'],
  }));
}

/**
 * Convert an Anthropic response `Message` to a wappa {@link GenerateResult}.
 *
 * Text blocks are concatenated (`null` when there are none); `tool_use`
 * blocks become {@link ToolCall}s; `stop_reason` maps `end_turn` → `'stop'`,
 * `tool_use` → `'tool_calls'`, `max_tokens` → `'length'`, anything else →
 * `'other'`; usage comes from `response.usage`. When the content holds more
 * than text — thinking blocks, tool calls — the whole content is kept as
 * `providerData`, so the turn is replayed to the API exactly as it was
 * produced (see {@link toAnthropicMessages}).
 */
export function fromAnthropicResponse(resp: Anthropic.Message): GenerateResult {
  let text: string | null = null;
  const toolCalls: ToolCall[] = [];
  for (const block of resp.content) {
    if (block.type === 'text') {
      text = (text ?? '') + block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: isRecord(block.input) ? block.input : {},
      });
    }
  }
  const result: GenerateResult = {
    text,
    toolCalls,
    finishReason: mapStopReason(resp.stop_reason),
  };
  if (resp.usage) {
    result.usage = {
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
    };
  }
  if (resp.content.some((block) => block.type !== 'text')) result.providerData = resp.content;
  return result;
}

function mapStopReason(reason: Anthropic.StopReason | null): GenerateResult['finishReason'] {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'other';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
