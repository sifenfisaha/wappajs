import { describe, expect, it } from 'vitest';
import type { Anthropic } from '@anthropic-ai/sdk';
import type { ChatMessage, Logger, ToolSpec } from '@wappajs/core';
import { AnthropicProvider, type AnthropicClientLike } from './provider.js';

/** Logger that records every call for assertions. */
function recordingLogger() {
  const entries: Array<{ level: string; msg: string; data?: object }> = [];
  const log = (level: string) => (msg: string, data?: object) => {
    entries.push(data === undefined ? { level, msg } : { level, msg, data });
  };
  const logger: Logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
  return { logger, entries };
}

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

/** Fake Anthropic client: records request bodies, replays scripted responses. */
class FakeClient implements AnthropicClientLike {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private readonly responses: Anthropic.Message[];

  constructor(responses: Anthropic.Message[]) {
    this.responses = [...responses];
  }

  readonly messages = {
    create: (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
      this.requests.push(params);
      const next = this.responses.shift();
      if (!next) return Promise.reject(new Error('FakeClient: no scripted response left'));
      return Promise.resolve(next);
    },
  };
}

describe('AnthropicProvider', () => {
  it("has name 'anthropic'", () => {
    const provider = new AnthropicProvider({ client: new FakeClient([]) });
    expect(provider.name).toBe('anthropic');
  });

  it('constructs a real client when none is injected', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    expect(provider.name).toBe('anthropic');
  });

  it('accepts clientOptions for the client constructor', () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      clientOptions: { baseURL: 'http://localhost:9999', maxRetries: 0 },
    });
    expect(provider.name).toBe('anthropic');
  });

  it('sends the exact request body (system, tools, default max_tokens 1024)', async () => {
    const client = new FakeClient([makeMessage([textBlock('hello!')])]);
    const provider = new AnthropicProvider({ client });
    const tools: ToolSpec[] = [
      {
        name: 'lookup',
        description: 'Look things up',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ];

    await provider.generate({
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'lookup',
          description: 'Look things up',
          input_schema: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
    });
    expect(Object.keys(client.requests[0]!).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'system',
      'tools',
    ]);
  });

  it('omits system, tools and temperature when unset', async () => {
    const client = new FakeClient([makeMessage([textBlock('ok')])]);
    const provider = new AnthropicProvider({ client });

    await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });

    const body = client.requests[0]!;
    expect('system' in body).toBe(false);
    expect('tools' in body).toBe(false);
    expect('temperature' in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model']);
  });

  it('forwards maxTokens, temperature and the model option', async () => {
    const client = new FakeClient([makeMessage([textBlock('ok')])]);
    const provider = new AnthropicProvider({ client, model: 'claude-haiku-x' });

    await provider.generate({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 2048,
      temperature: 0.3,
    });

    expect(client.requests[0]).toMatchObject({
      model: 'claude-haiku-x',
      max_tokens: 2048,
      temperature: 0.3,
    });
  });

  it('drops temperature for the default model (claude-sonnet-5) and warns once across two calls', async () => {
    const client = new FakeClient([makeMessage([textBlock('a')]), makeMessage([textBlock('b')])]);
    const { logger, entries } = recordingLogger();
    const provider = new AnthropicProvider({ client, logger });

    await provider.generate({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });
    await provider.generate({ messages: [{ role: 'user', content: 'again' }], temperature: 0.7 });

    expect(client.requests).toHaveLength(2);
    expect('temperature' in client.requests[0]!).toBe(false);
    expect('temperature' in client.requests[1]!).toBe(false);
    const warns = entries.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain('claude-sonnet-5 does not support temperature; ignoring');
  });

  it.each([
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-sonnet-5-20260115', // dated ids match by prefix
  ])('drops temperature for sampling-rejecting model %s', async (model) => {
    const client = new FakeClient([makeMessage([textBlock('ok')])]);
    const { logger, entries } = recordingLogger();
    const provider = new AnthropicProvider({ client, logger, model });

    await provider.generate({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 });

    expect('temperature' in client.requests[0]!).toBe(false);
    expect(entries.filter((e) => e.level === 'warn')).toHaveLength(1);
  });

  it('forwards temperature for claude-sonnet-4-6 without warning', async () => {
    const client = new FakeClient([makeMessage([textBlock('ok')])]);
    const { logger, entries } = recordingLogger();
    const provider = new AnthropicProvider({ client, logger, model: 'claude-sonnet-4-6' });

    await provider.generate({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.3 });

    expect(client.requests[0]).toMatchObject({ model: 'claude-sonnet-4-6', temperature: 0.3 });
    expect(entries.filter((e) => e.level === 'warn')).toHaveLength(0);
  });

  it('degrades tool history to plain text when the request has no tools (maxTurns fallback)', async () => {
    const client = new FakeClient([makeMessage([textBlock('It shipped; arrives Tuesday.')])]);
    const provider = new AnthropicProvider({ client });
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
      { role: 'user', content: 'so when does it arrive?' },
    ];

    await provider.generate({ system: 'support', messages: history });

    expect(client.requests[0]!.messages).toEqual([
      { role: 'user', content: 'where is my order?' },
      {
        role: 'assistant',
        content: '[called find_order({"id":42})]\n[called eta({"id":42})]',
      },
      { role: 'user', content: '[find_order result] shipped' },
      { role: 'user', content: '[eta result] Tuesday' },
      { role: 'user', content: 'so when does it arrive?' },
    ]);
    const raw = JSON.stringify(client.requests[0]);
    expect(raw).not.toContain('tool_use');
    expect(raw).not.toContain('tool_result');
    expect('tools' in client.requests[0]!).toBe(false);
  });

  it('degrades tool history when tools is an empty array', async () => {
    const client = new FakeClient([makeMessage([textBlock('ok')])]);
    const provider = new AnthropicProvider({ client });

    await provider.generate({
      messages: [
        {
          role: 'assistant',
          content: 'Checking.',
          toolCalls: [{ id: 'tc_1', name: 'lookup', arguments: { q: 'x' } }],
        },
        { role: 'tool', content: 'found', toolCallId: 'tc_1', toolName: 'lookup' },
      ],
      tools: [],
    });

    const raw = JSON.stringify(client.requests[0]);
    expect(raw).not.toContain('tool_use');
    expect(raw).not.toContain('tool_result');
    expect(client.requests[0]!.messages).toEqual([
      { role: 'assistant', content: 'Checking.\n[called lookup({"q":"x"})]' },
      { role: 'user', content: '[lookup result] found' },
    ]);
  });

  it('sends tool history as merged tool_result blocks and maps the text response', async () => {
    const client = new FakeClient([
      makeMessage([textBlock('Your order shipped.')], 'end_turn', {
        input_tokens: 77,
        output_tokens: 12,
      }),
    ]);
    const provider = new AnthropicProvider({ client });
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
    ];
    const tools: ToolSpec[] = [
      { name: 'find_order', description: 'Find an order', parameters: { type: 'object' } },
      { name: 'eta', description: 'Estimate arrival', parameters: { type: 'object' } },
    ];

    const result = await provider.generate({ system: 'support', messages: history, tools });

    expect(client.requests[0]!.messages).toEqual([
      { role: 'user', content: 'where is my order?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc_1', name: 'find_order', input: { id: 42 } },
          { type: 'tool_use', id: 'tc_2', name: 'eta', input: { id: 42 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_1', content: 'shipped' },
          { type: 'tool_result', tool_use_id: 'tc_2', content: 'Tuesday' },
        ],
      },
    ]);
    expect(result).toEqual({
      text: 'Your order shipped.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 77, outputTokens: 12 },
    });
  });

  it('maps a tool_use response to toolCalls with null text', async () => {
    const client = new FakeClient([
      makeMessage([toolUseBlock('tc_1', 'lookup', { q: 'order 42' })], 'tool_use'),
    ]);
    const provider = new AnthropicProvider({ client });

    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([{ id: 'tc_1', name: 'lookup', arguments: { q: 'order 42' } }]);
    expect(result.finishReason).toBe('tool_calls');
  });

  it("maps a max_tokens stop to finishReason 'length'", async () => {
    const client = new FakeClient([makeMessage([textBlock('truncat')], 'max_tokens')]);
    const provider = new AnthropicProvider({ client });

    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.finishReason).toBe('length');
    expect(result.text).toBe('truncat');
  });

  it('propagates client errors', async () => {
    const client = new FakeClient([]);
    const provider = new AnthropicProvider({ client });

    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('no scripted response left');
  });
});

describe('AnthropicProvider request options', () => {
  it('caches the stable system part when the request carries systemParts', async () => {
    const client = new FakeClient([makeMessage([textBlock('ok')])]);
    const provider = new AnthropicProvider({ client });
    await provider.generate({
      system: 'facts\n\nnow',
      systemParts: { stable: 'facts', dynamic: 'now' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(client.requests[0]!.system).toEqual([
      { type: 'text', text: 'facts', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'now' },
    ]);
  });

  it('sends effort as output_config and thinking as given, only when set', async () => {
    const client = new FakeClient([makeMessage([textBlock('ok')]), makeMessage([textBlock('ok')])]);
    const plain = new AnthropicProvider({ client });
    await plain.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(client.requests[0]).not.toHaveProperty('output_config');
    expect(client.requests[0]).not.toHaveProperty('thinking');

    const tuned = new AnthropicProvider({ client, effort: 'low', thinking: { type: 'adaptive' } });
    await tuned.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(client.requests[1]).toMatchObject({
      output_config: { effort: 'low' },
      thinking: { type: 'adaptive' },
    });
  });

  it('merges extraParams after its own fields', async () => {
    const client = new FakeClient([makeMessage([textBlock('ok')])]);
    const provider = new AnthropicProvider({
      client,
      extraParams: { metadata: { user_id: 'u1' }, max_tokens: 4096 },
    });
    await provider.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 512 });
    expect(client.requests[0]).toMatchObject({ metadata: { user_id: 'u1' }, max_tokens: 4096 });
  });

  it('keeps the blocks of a tool-calling turn and replays them, thinking included, on the next call', async () => {
    const thinking: Anthropic.ThinkingBlock = { type: 'thinking', thinking: '', signature: 'sig-1' };
    const client = new FakeClient([
      makeMessage([thinking, toolUseBlock('c1', 'lookup', { q: 'x' })], 'tool_use'),
      makeMessage([textBlock('found it')]),
    ]);
    const provider = new AnthropicProvider({ client });
    const tools: ToolSpec[] = [{ name: 'lookup', description: 'l', parameters: { type: 'object' } }];

    const first = await provider.generate({ messages: [{ role: 'user', content: 'go' }], tools });
    expect(first.toolCalls).toEqual([{ id: 'c1', name: 'lookup', arguments: { q: 'x' } }]);
    expect(first.providerData).toBeDefined();

    // What the Agent does with the result: append it, with providerData, then the tool result.
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: first.toolCalls, providerData: first.providerData },
      { role: 'tool', content: 'ok', toolCallId: 'c1', toolName: 'lookup' },
    ];
    const second = await provider.generate({ messages: history, tools });
    expect(second.text).toBe('found it');
    expect(client.requests[1]!.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } },
      ],
    });
  });

  it('warns when the model refuses the turn', async () => {
    const { logger, entries } = recordingLogger();
    const client = new FakeClient([makeMessage([], 'refusal')]);
    const provider = new AnthropicProvider({ client, logger });
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ text: null, toolCalls: [], finishReason: 'other' });
    expect(entries.some((e) => e.level === 'warn' && e.msg.includes('refused'))).toBe(true);
  });
});
