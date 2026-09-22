import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from './agent.js';
import { defineTool } from './tool.js';
import { createSession } from './session.js';
import { ScriptedProvider } from './testing.js';
import type { Context } from './context.js';
import type { InboundMessage } from './messages.js';
import type { ChatMessage } from './provider.js';
import type { Logger } from './logger.js';
import type { Bot } from './bot.js';

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeCtx(msg: Partial<InboundMessage> = {}): Context {
  const message: InboundMessage = {
    id: 'm1',
    chatId: 'chat-1',
    senderId: 'chat-1',
    timestamp: 0,
    isGroup: false,
    fromMe: false,
    text: 'hi',
    ...msg,
  };
  return {
    message,
    bot: {} as Bot,
    session: createSession(),
    state: {},
    reply: async () => ({}),
    sendTyping: async () => {},
    logger: silentLogger,
  };
}

describe('Agent.run', () => {
  it('appends user + assistant messages and returns the final text', async () => {
    const provider = new ScriptedProvider(['Hello there!']);
    const agent = new Agent({ instructions: 'be nice', provider });
    const ctx = makeCtx({ text: 'hi' });

    await expect(agent.run(ctx)).resolves.toBe('Hello there!');
    expect(ctx.session.history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there!' },
    ]);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      system: 'be nice',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1024,
    });
    expect(provider.calls[0]!.temperature).toBeUndefined();
    expect(provider.calls[0]!.tools).toBeUndefined();
  });

  it('passes maxTokens/temperature overrides and tool specs', async () => {
    const provider = new ScriptedProvider(['ok']);
    const tool = defineTool({
      name: 'ping',
      description: 'pings',
      execute: () => 'pong',
    });
    const agent = new Agent({
      instructions: 'sys',
      provider,
      tools: [tool],
      maxTokens: 99,
      temperature: 0.3,
    });
    await agent.run(makeCtx());
    expect(provider.calls[0]).toMatchObject({
      maxTokens: 99,
      temperature: 0.3,
      tools: [{ name: 'ping', description: 'pings', parameters: tool.parameters }],
    });
  });

  it('re-evaluates function instructions per message with the ctx', async () => {
    const provider = new ScriptedProvider(['a', 'b']);
    const agent = new Agent({
      instructions: async (ctx) => `sys for ${ctx.message.chatId}`,
      provider,
    });
    await agent.run(makeCtx({ chatId: 'alpha' }));
    await agent.run(makeCtx({ chatId: 'beta' }));
    expect(provider.calls[0]!.system).toBe('sys for alpha');
    expect(provider.calls[1]!.system).toBe('sys for beta');
  });

  it('executes tool calls sequentially and appends assistant + tool messages', async () => {
    const invoked: unknown[] = [];
    const tool = defineTool({
      name: 'lookup',
      description: 'looks things up',
      parameters: z.object({ key: z.string() }),
      execute: (args, ctx) => {
        invoked.push([args, ctx.message.chatId]);
        return { found: args.key };
      },
    });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'lookup', arguments: { key: 'k1' } }] },
      'All done.',
    ]);
    const agent = new Agent({ instructions: 'sys', provider, tools: [tool] });
    const ctx = makeCtx({ text: 'find k1' });

    await expect(agent.run(ctx)).resolves.toBe('All done.');
    expect(invoked).toEqual([[{ key: 'k1' }, 'chat-1']]);
    expect(ctx.session.history).toEqual([
      { role: 'user', content: 'find k1' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: { key: 'k1' } }],
      },
      { role: 'tool', content: '{"found":"k1"}', toolCallId: 'c1', toolName: 'lookup' },
      { role: 'assistant', content: 'All done.' },
    ]);
    // Second request saw the assistant tool-call message and the tool result.
    const secondMessages = provider.calls[1]!.messages;
    expect(secondMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('turns an unknown tool name into an error tool-result and continues the loop', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c9', name: 'ghost', arguments: {} }] },
      'Recovered.',
    ]);
    const agent = new Agent({ instructions: 'sys', provider, tools: [] });
    const ctx = makeCtx();

    await expect(agent.run(ctx)).resolves.toBe('Recovered.');
    expect(ctx.session.history[2]).toEqual({
      role: 'tool',
      content: 'Error: unknown tool ghost',
      toolCallId: 'c9',
      toolName: 'ghost',
    });
  });

  it('forces a final no-tools generate when maxTurns is hit', async () => {
    const tool = defineTool({ name: 'noop', description: 'x', execute: () => 'done' });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 't1', name: 'noop', arguments: {} }] },
      { toolCalls: [{ id: 't2', name: 'noop', arguments: {} }] },
      'Forced answer.',
    ]);
    const agent = new Agent({ instructions: 'sys', provider, tools: [tool], maxTurns: 2 });
    const ctx = makeCtx();

    await expect(agent.run(ctx)).resolves.toBe('Forced answer.');
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[0]!.tools).toBeDefined();
    expect(provider.calls[1]!.tools).toBeDefined();
    expect(provider.calls[2]!.tools).toBeUndefined(); // final call must carry no tools
    // Both requested tool rounds were still executed.
    const toolMessages = ctx.session.history.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
  });

  it('appends nothing for a null or empty final text and returns null', async () => {
    for (const text of [null, '']) {
      const provider = new ScriptedProvider([{ text, toolCalls: [], finishReason: 'stop' }]);
      const agent = new Agent({ instructions: 'sys', provider });
      const ctx = makeCtx({ text: 'hello' });
      await expect(agent.run(ctx)).resolves.toBeNull();
      expect(ctx.session.history).toEqual([{ role: 'user', content: 'hello' }]);
    }
  });

  it('restores the pre-run history when the loop errors mid-way', async () => {
    const tool = defineTool({ name: 'noop', description: 'x', execute: () => 'done' });
    // Script has one tool-call entry; the second generate exhausts the script and rejects.
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 't1', name: 'noop', arguments: {} }] },
    ]);
    const agent = new Agent({ instructions: 'sys', provider, tools: [tool] });
    const ctx = makeCtx();
    const prior: ChatMessage[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'sure' },
    ];
    ctx.session.history.push(...prior);

    await expect(agent.run(ctx)).rejects.toThrow(/script exhausted/);
    expect(ctx.session.history).toEqual(prior);
  });

  it('trims history to maxHistoryMessages without splitting a tool group', async () => {
    const tool = defineTool({ name: 'noop', description: 'x', execute: () => 'done' });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 't1', name: 'noop', arguments: {} }] },
      'Final.',
    ]);
    const agent = new Agent({
      instructions: 'sys',
      provider,
      tools: [tool],
      maxHistoryMessages: 2,
    });
    const ctx = makeCtx();
    ctx.session.history.push(
      { role: 'user', content: 'old-1' },
      { role: 'assistant', content: 'old-2' }
    );

    await agent.run(ctx);
    // Full history was: old-1, old-2, user, assistant(toolCalls), tool, Final. → 6 msgs.
    // A naive last-2 window would start on the 'tool' message, splitting the group; the
    // window aligns forward to a user message and, since none follows, falls back to the
    // last user message — keeping the current turn's whole group.
    expect(ctx.session.history).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'noop', arguments: {} }],
      },
      { role: 'tool', content: 'done', toolCallId: 't1', toolName: 'noop' },
      { role: 'assistant', content: 'Final.' },
    ]);
  });

  it('drops a tool group whole when the window boundary lands on its head', async () => {
    const provider = new ScriptedProvider(['ok']);
    const agent = new Agent({ instructions: 'sys', provider, maxHistoryMessages: 4 });
    const ctx = makeCtx({ text: 'now' });
    ctx.session.history.push(
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'noop', arguments: {} }] },
      { role: 'tool', content: 'done', toolCallId: 'a', toolName: 'noop' }
    );

    await agent.run(ctx);
    // 5 messages total; the window of 4 starts at the assistant tool-call head — it must
    // align forward to the next user message (never start on assistant/tool, never split
    // the group), so the whole group is dropped.
    expect(ctx.session.history).toEqual([
      { role: 'user', content: 'now' },
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('starts every provider window with a user message once the count cap is exceeded', async () => {
    const provider = new ScriptedProvider(Array.from({ length: 12 }, (_, i) => `reply-${i}`));
    const agent = new Agent({ instructions: 'sys', provider, maxHistoryMessages: 4 });
    const session = createSession();
    for (let i = 0; i < 12; i++) {
      const ctx = makeCtx({ id: `m${i}`, text: `msg-${i}` });
      ctx.session = session;
      await agent.run(ctx);
    }
    // A window that opens with an assistant (or tool) message is rejected by providers
    // ('first message must be user') — every single request must start with a user turn.
    expect(provider.calls).toHaveLength(12);
    for (const call of provider.calls) {
      expect(call.messages.length).toBeGreaterThan(0);
      expect(call.messages[0]!.role).toBe('user');
    }
  });

  it('falls back to the last user message when a tool group exceeds the window', async () => {
    const tool = defineTool({ name: 'noop', description: 'x', execute: () => 'done' });
    const provider = new ScriptedProvider([
      {
        toolCalls: [1, 2, 3, 4].map((i) => ({ id: `t${i}`, name: 'noop', arguments: {} })),
      },
      'Recovered.',
    ]);
    const agent = new Agent({
      instructions: 'sys',
      provider,
      tools: [tool],
      maxHistoryMessages: 3,
    });
    const ctx = makeCtx({ text: 'do it' });

    await expect(agent.run(ctx)).resolves.toBe('Recovered.');
    // After the 4-call tool round the count window holds only tool messages; the request
    // must not be empty — it falls back to the last user message and its whole group.
    const second = provider.calls[1]!.messages;
    expect(second.length).toBeGreaterThan(0);
    expect(second[0]).toEqual({ role: 'user', content: 'do it' });
  });

  it('drops the oldest user turns when maxHistoryChars is exceeded', async () => {
    const provider = new ScriptedProvider(['ok']);
    const agent = new Agent({ instructions: 'sys', provider, maxHistoryChars: 20 });
    const ctx = makeCtx({ text: 'latest' });
    ctx.session.history.push(
      { role: 'user', content: 'x'.repeat(40) },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'y'.repeat(30) },
      { role: 'assistant', content: 'another' }
    );

    await agent.run(ctx);
    // Whole user-turn groups are dropped oldest-first until the window fits the cap.
    expect(provider.calls[0]!.messages).toEqual([{ role: 'user', content: 'latest' }]);
    // The persisted history is capped the same way — a failed turn rolls back, so an
    // oversized window would otherwise be retried forever.
    expect(ctx.session.history).toEqual([
      { role: 'user', content: 'latest' },
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('never drops the final user message even when it alone exceeds maxHistoryChars', async () => {
    const provider = new ScriptedProvider(['ok']);
    const agent = new Agent({ instructions: 'sys', provider, maxHistoryChars: 10 });
    const ctx = makeCtx({ text: 'z'.repeat(100) });
    ctx.session.history.push(
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'sure' }
    );

    await agent.run(ctx);
    expect(provider.calls[0]!.messages).toEqual([{ role: 'user', content: 'z'.repeat(100) }]);
    expect(ctx.session.history.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('sends the provider a windowed view of long histories', async () => {
    const provider = new ScriptedProvider(['ok']);
    const agent = new Agent({ instructions: 'sys', provider, maxHistoryMessages: 3 });
    const ctx = makeCtx({ text: 'latest' });
    for (let i = 0; i < 10; i++) {
      ctx.session.history.push({ role: 'user', content: `old-${i}` });
      ctx.session.history.push({ role: 'assistant', content: `reply-${i}` });
    }

    await agent.run(ctx);
    const sent = provider.calls[0]!.messages;
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({ role: 'user', content: 'latest' });
  });

  describe('user message rendering', () => {
    async function renderedFor(msg: Partial<InboundMessage>): Promise<string> {
      const provider = new ScriptedProvider(['ok']);
      const agent = new Agent({ instructions: 'sys', provider });
      await agent.run(makeCtx(msg));
      return provider.calls[0]!.messages.at(-1)!.content;
    }

    it('uses text as-is in DMs', async () => {
      await expect(renderedFor({ text: 'plain text' })).resolves.toBe('plain text');
    });

    it('prefixes the sender in groups (senderName preferred, senderId fallback)', async () => {
      await expect(
        renderedFor({ text: 'yo', isGroup: true, senderName: 'Ana', senderId: 'u1' })
      ).resolves.toBe('Ana: yo');
      await expect(
        renderedFor({ text: 'yo', isGroup: true, senderId: 'u1' })
      ).resolves.toBe('u1: yo');
    });

    it('renders media as a placeholder plus caption', async () => {
      const media = { kind: 'image' as const, download: async () => Buffer.alloc(0) };
      await expect(renderedFor({ text: 'look at this', media })).resolves.toBe(
        '[image] look at this'
      );
      await expect(renderedFor({ text: undefined, media })).resolves.toBe('[image]');
    });

    it('renders voice notes as [voice note]', async () => {
      const media = { kind: 'audio' as const, ptt: true, download: async () => Buffer.alloc(0) };
      await expect(renderedFor({ text: undefined, media })).resolves.toBe('[voice note]');
    });

    it('renders locations as [location: lat, lon]', async () => {
      await expect(
        renderedFor({ text: undefined, location: { latitude: 9.005, longitude: 38.763 } })
      ).resolves.toBe('[location: 9.005, 38.763]');
    });
  });
});

describe('Agent knowledge (the stable half of the prompt)', () => {
  it('sends knowledge before the instructions, and the two parts separately', async () => {
    const provider = new ScriptedProvider(['ok']);
    const agent = new Agent({
      instructions: (ctx) => `chat ${ctx.message.chatId}`,
      knowledge: 'The catalogue.',
      provider,
    });
    await agent.run(makeCtx({ chatId: 'alpha' }));
    expect(provider.calls[0]).toMatchObject({
      system: 'The catalogue.\n\nchat alpha',
      systemParts: { stable: 'The catalogue.', dynamic: 'chat alpha' },
    });
  });

  it('re-evaluates function knowledge per message, and sends it alone when instructions are empty', async () => {
    let version = 1;
    const provider = new ScriptedProvider(['a', 'b']);
    const agent = new Agent({
      instructions: '',
      knowledge: async () => `facts v${version}`,
      provider,
    });
    await agent.run(makeCtx());
    version = 2;
    await agent.run(makeCtx());
    expect(provider.calls[0]!.system).toBe('facts v1');
    expect(provider.calls[0]!.systemParts).toEqual({ stable: 'facts v1', dynamic: '' });
    expect(provider.calls[1]!.system).toBe('facts v2');
  });

  it('sends no systemParts without knowledge', async () => {
    const provider = new ScriptedProvider(['ok']);
    const agent = new Agent({ instructions: 'sys', provider });
    await agent.run(makeCtx());
    expect(provider.calls[0]!.system).toBe('sys');
    expect('systemParts' in provider.calls[0]!).toBe(false);
  });
});

describe('Agent providerData (what a provider needs to replay its own turns)', () => {
  it('keeps it on the assistant messages it appends and hands it back on the next call', async () => {
    const tool = defineTool({ name: 'ping', description: 'pings', execute: () => 'pong' });
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
        providerData: { blocks: ['thinking', 'tool_use'] },
      },
      { text: 'Done.', providerData: { blocks: ['thinking', 'text'] } },
    ]);
    const agent = new Agent({ instructions: 'sys', provider, tools: [tool] });
    const ctx = makeCtx({ text: 'go' });

    await expect(agent.run(ctx)).resolves.toBe('Done.');
    expect(ctx.session.history).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
        providerData: { blocks: ['thinking', 'tool_use'] },
      },
      { role: 'tool', content: 'pong', toolCallId: 'c1', toolName: 'ping' },
      { role: 'assistant', content: 'Done.', providerData: { blocks: ['thinking', 'text'] } },
    ]);
    expect(provider.calls[1]!.messages[1]).toMatchObject({
      providerData: { blocks: ['thinking', 'tool_use'] },
    });
  });

  it('keeps it on the forced no-tools answer after maxTurns', async () => {
    const tool = defineTool({ name: 'ping', description: 'pings', execute: () => 'pong' });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }] },
      { text: 'Forced.', providerData: ['final'] },
    ]);
    const agent = new Agent({ instructions: 'sys', provider, tools: [tool], maxTurns: 1 });
    const ctx = makeCtx();
    await expect(agent.run(ctx)).resolves.toBe('Forced.');
    expect(ctx.session.history.at(-1)).toEqual({
      role: 'assistant',
      content: 'Forced.',
      providerData: ['final'],
    });
  });

  it('adds no providerData key when the provider returned none', async () => {
    const provider = new ScriptedProvider(['plain']);
    const agent = new Agent({ instructions: 'sys', provider });
    const ctx = makeCtx();
    await agent.run(ctx);
    expect('providerData' in ctx.session.history[1]!).toBe(false);
  });
});
