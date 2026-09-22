import { describe, expect, it } from 'vitest';
import type { Anthropic } from '@anthropic-ai/sdk';
import type { ChatMessage } from '@wappajs/core';
import {
  degradeToolHistory,
  fromAnthropicResponse,
  toAnthropicMessages,
  toAnthropicSystem,
  toAnthropicTools,
} from './mapping.js';

function makeMessage(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.StopReason | null = 'end_turn',
  usage?: Partial<Anthropic.Usage>,
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    container: null,
    content,
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 0,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      ...usage,
    },
  };
}

const textBlock = (text: string): Anthropic.TextBlock => ({ type: 'text', text, citations: null });

const toolUseBlock = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
  caller: { type: 'direct' },
});

describe('toAnthropicMessages', () => {
  it('maps plain user/assistant turns to string-content messages', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
      { role: 'user', content: 'how are you?' },
    ];
    expect(toAnthropicMessages('be nice', history)).toEqual({
      system: 'be nice',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello!' },
        { role: 'user', content: 'how are you?' },
      ],
    });
  });

  it('omits the system key entirely when system is undefined', () => {
    const result = toAnthropicMessages(undefined, [{ role: 'user', content: 'hi' }]);
    expect('system' in result).toBe(false);
    expect(result.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('maps an assistant message with text and toolCalls to text + tool_use blocks', () => {
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [
          { id: 'tc_1', name: 'lookup', arguments: { q: 'order 42' } },
          { id: 'tc_2', name: 'notify', arguments: {} },
        ],
      },
    ];
    expect(toAnthropicMessages(undefined, history).messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tc_1', name: 'lookup', input: { q: 'order 42' } },
          { type: 'tool_use', id: 'tc_2', name: 'notify', input: {} },
        ],
      },
    ]);
  });

  it('emits no text block for an empty-text assistant message with toolCalls', () => {
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_1', name: 'lookup', arguments: { q: 'x' } }],
      },
    ];
    expect(toAnthropicMessages(undefined, history).messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tc_1', name: 'lookup', input: { q: 'x' } }],
      },
    ]);
  });

  it('merges consecutive tool messages into ONE user message of tool_result blocks', () => {
    const history: ChatMessage[] = [
      { role: 'tool', content: 'result A', toolCallId: 'tc_1', toolName: 'a' },
      { role: 'tool', content: 'result B', toolCallId: 'tc_2', toolName: 'b' },
      { role: 'tool', content: 'result C', toolCallId: 'tc_3', toolName: 'c' },
    ];
    expect(toAnthropicMessages(undefined, history).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_1', content: 'result A' },
          { type: 'tool_result', tool_use_id: 'tc_2', content: 'result B' },
          { type: 'tool_result', tool_use_id: 'tc_3', content: 'result C' },
        ],
      },
    ]);
  });

  it('omits the content key for an empty-string tool result (API rejects empty text blocks)', () => {
    const history: ChatMessage[] = [
      { role: 'tool', content: '', toolCallId: 'tc_1', toolName: 'ping' },
      { role: 'tool', content: 'pong', toolCallId: 'tc_2', toolName: 'other' },
    ];
    const { messages } = toAnthropicMessages(undefined, history);
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_1' },
          { type: 'tool_result', tool_use_id: 'tc_2', content: 'pong' },
        ],
      },
    ]);
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;
    expect('content' in blocks[0]!).toBe(false);
  });

  it('maps a multi-turn history with two separate tool rounds', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'where is my order?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', name: 'find_customer', arguments: { phone: '+1555' } },
          { id: 'tc_2', name: 'find_order', arguments: { id: 42 } },
        ],
      },
      { role: 'tool', content: 'Ada', toolCallId: 'tc_1', toolName: 'find_customer' },
      { role: 'tool', content: 'shipped', toolCallId: 'tc_2', toolName: 'find_order' },
      {
        role: 'assistant',
        content: 'One more check.',
        toolCalls: [{ id: 'tc_3', name: 'eta', arguments: { id: 42 } }],
      },
      { role: 'tool', content: 'Tuesday', toolCallId: 'tc_3', toolName: 'eta' },
      { role: 'user', content: 'thanks' },
    ];
    expect(toAnthropicMessages('support agent', history)).toEqual({
      system: 'support agent',
      messages: [
        { role: 'user', content: 'where is my order?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'find_customer', input: { phone: '+1555' } },
            { type: 'tool_use', id: 'tc_2', name: 'find_order', input: { id: 42 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: 'Ada' },
            { type: 'tool_result', tool_use_id: 'tc_2', content: 'shipped' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'One more check.' },
            { type: 'tool_use', id: 'tc_3', name: 'eta', input: { id: 42 } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tc_3', content: 'Tuesday' }],
        },
        { role: 'user', content: 'thanks' },
      ],
    });
  });
});

describe('degradeToolHistory', () => {
  it('degrades assistant tool calls and tool results to plain text, preserving order', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'where is my order?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc_1', name: 'find_order', arguments: { id: 42 } },
          { id: 'tc_2', name: 'eta', arguments: { id: 42 } },
        ],
      },
      { role: 'tool', content: 'shipped', toolCallId: 'tc_1', toolName: 'find_order' },
      { role: 'tool', content: 'Tuesday', toolCallId: 'tc_2', toolName: 'eta' },
      { role: 'user', content: 'thanks' },
    ];
    expect(degradeToolHistory(history)).toEqual([
      { role: 'user', content: 'where is my order?' },
      { role: 'assistant', content: '[called find_order({"id":42})]\n[called eta({"id":42})]' },
      { role: 'user', content: '[find_order result] shipped' },
      { role: 'user', content: '[eta result] Tuesday' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('appends tool-call text to non-empty assistant text', () => {
    expect(
      degradeToolHistory([
        {
          role: 'assistant',
          content: 'Let me check.',
          toolCalls: [{ id: 'tc_1', name: 'lookup', arguments: { q: 'x' } }],
        },
      ]),
    ).toEqual([{ role: 'assistant', content: 'Let me check.\n[called lookup({"q":"x"})]' }]);
  });

  it("falls back to 'tool' for a tool message without toolName", () => {
    expect(degradeToolHistory([{ role: 'tool', content: 'out', toolCallId: 'tc_1' }])).toEqual([
      { role: 'user', content: '[tool result] out' },
    ]);
  });

  it('leaves plain user/assistant messages untouched', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
    ];
    expect(degradeToolHistory(history)).toEqual(history);
  });
});

describe('toAnthropicTools', () => {
  it('maps ToolSpec to Anthropic tool definitions', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    expect(
      toAnthropicTools([{ name: 'lookup', description: 'Look things up', parameters: schema }]),
    ).toEqual([{ name: 'lookup', description: 'Look things up', input_schema: schema }]);
  });

  it('maps an empty list to an empty list', () => {
    expect(toAnthropicTools([])).toEqual([]);
  });
});

describe('fromAnthropicResponse', () => {
  it('concatenates text blocks', () => {
    const result = fromAnthropicResponse(makeMessage([textBlock('Hello, '), textBlock('world.')]));
    expect(result.text).toBe('Hello, world.');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
  });

  it('returns null text when there are no text blocks', () => {
    const result = fromAnthropicResponse(
      makeMessage([toolUseBlock('tc_1', 'lookup', { q: 'x' })], 'tool_use'),
    );
    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([{ id: 'tc_1', name: 'lookup', arguments: { q: 'x' } }]);
    expect(result.finishReason).toBe('tool_calls');
  });

  it('extracts mixed text + tool_use content', () => {
    const result = fromAnthropicResponse(
      makeMessage(
        [textBlock('Checking...'), toolUseBlock('tc_9', 'eta', { id: 42 })],
        'tool_use',
      ),
    );
    expect(result.text).toBe('Checking...');
    expect(result.toolCalls).toEqual([{ id: 'tc_9', name: 'eta', arguments: { id: 42 } }]);
  });

  it('normalizes a non-object tool_use input to {}', () => {
    const result = fromAnthropicResponse(
      makeMessage(
        [toolUseBlock('tc_1', 'a', null), toolUseBlock('tc_2', 'b', 'oops')],
        'tool_use',
      ),
    );
    expect(result.toolCalls).toEqual([
      { id: 'tc_1', name: 'a', arguments: {} },
      { id: 'tc_2', name: 'b', arguments: {} },
    ]);
  });

  it.each([
    ['end_turn', 'stop'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['stop_sequence', 'other'],
    ['pause_turn', 'other'],
    ['refusal', 'other'],
    ['model_context_window_exceeded', 'other'],
  ] as Array<[Anthropic.StopReason, string]>)(
    "maps stop_reason '%s' to finishReason '%s'",
    (stopReason, finishReason) => {
      expect(fromAnthropicResponse(makeMessage([textBlock('x')], stopReason)).finishReason).toBe(
        finishReason,
      );
    },
  );

  it("maps a null stop_reason to 'other'", () => {
    expect(fromAnthropicResponse(makeMessage([textBlock('x')], null)).finishReason).toBe('other');
  });

  it('extracts usage from response.usage', () => {
    const result = fromAnthropicResponse(
      makeMessage([textBlock('hi')], 'end_turn', { input_tokens: 123, output_tokens: 45 }),
    );
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
  });

  it('handles an empty content array (max_tokens cut-off before any block)', () => {
    const result = fromAnthropicResponse(makeMessage([], 'max_tokens'));
    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('length');
  });
});

const thinkingBlock = (thinking: string, signature: string): Anthropic.ThinkingBlock => ({
  type: 'thinking',
  thinking,
  signature,
});

describe('replaying a turn from providerData', () => {
  it('rebuilds the response blocks as request blocks, thinking included', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'find k1' },
      {
        role: 'assistant',
        content: 'Looking.',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: { key: 'k1' } }],
        providerData: [
          thinkingBlock('let me see', 'sig123'),
          textBlock('Looking.'),
          toolUseBlock('c1', 'lookup', { key: 'k1' }),
        ],
      },
      { role: 'tool', content: 'found', toolCallId: 'c1', toolName: 'lookup' },
    ];
    const { messages } = toAnthropicMessages(undefined, history);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'let me see', signature: 'sig123' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'c1', name: 'lookup', input: { key: 'k1' } },
      ],
    });
    // Response-only fields never reach the request.
    const blocks = (messages[1]!.content as Array<Record<string, unknown>>);
    expect(blocks[1]).not.toHaveProperty('citations');
    expect(blocks[2]).not.toHaveProperty('caller');
  });

  it('replays a text-only turn that carried thinking, and drops empty text blocks', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Hello.',
        providerData: [thinkingBlock('', 'sig'), textBlock(''), textBlock('Hello.')],
      },
    ];
    const { messages } = toAnthropicMessages(undefined, history);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'Hello.' },
      ],
    });
  });

  it('falls back to text + tool_use when providerData is not a list of blocks', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
        providerData: { someOtherProvider: true },
      },
    ];
    const { messages } = toAnthropicMessages(undefined, history);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'ping', input: {} }],
    });
  });

  it('falls back to the plain text when every replay block is empty', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'kept', providerData: [textBlock('')] },
    ];
    const { messages } = toAnthropicMessages(undefined, history);
    expect(messages[1]).toEqual({ role: 'assistant', content: 'kept' });
  });

  it('degradeToolHistory drops providerData with the tool blocks, keeps it on text turns', () => {
    const degraded = degradeToolHistory([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
        providerData: [toolUseBlock('c1', 'ping', {})],
      },
      { role: 'assistant', content: 'done', providerData: [thinkingBlock('t', 's')] },
    ]);
    expect(degraded[0]).toEqual({ role: 'assistant', content: '[called ping({})]' });
    expect(degraded[1]).toHaveProperty('providerData');
  });
});

describe('toAnthropicSystem', () => {
  it('returns the plain string when there are no parts', () => {
    expect(toAnthropicSystem('sys', undefined)).toBe('sys');
    expect(toAnthropicSystem(undefined, undefined)).toBeUndefined();
  });

  it('marks the stable part with a cache breakpoint and appends the dynamic part', () => {
    expect(toAnthropicSystem('facts\n\nnow', { stable: 'facts', dynamic: 'now' })).toEqual([
      { type: 'text', text: 'facts', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'now' },
    ]);
  });

  it('omits an empty dynamic part, and falls back to the string for an empty stable part', () => {
    expect(toAnthropicSystem('facts', { stable: 'facts', dynamic: '' })).toEqual([
      { type: 'text', text: 'facts', cache_control: { type: 'ephemeral' } },
    ]);
    expect(toAnthropicSystem('now', { stable: '', dynamic: 'now' })).toBe('now');
  });

  it('is what toAnthropicMessages puts on the request', () => {
    const { system } = toAnthropicMessages('facts\n\nnow', [{ role: 'user', content: 'hi' }], {
      stable: 'facts',
      dynamic: 'now',
    });
    expect(system).toEqual([
      { type: 'text', text: 'facts', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'now' },
    ]);
  });
});

describe('fromAnthropicResponse providerData', () => {
  it('keeps the whole content when it holds more than text', () => {
    const content = [thinkingBlock('hm', 'sig'), toolUseBlock('c1', 'ping', {})];
    const result = fromAnthropicResponse(makeMessage(content, 'tool_use'));
    expect(result.providerData).toBe(content);
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'ping', arguments: {} }]);
  });

  it('adds no providerData for a text-only response', () => {
    const result = fromAnthropicResponse(makeMessage([textBlock('plain')]));
    expect('providerData' in result).toBe(false);
  });
});
