import { describe, expect, it } from 'vitest';
import { MockTransport, ScriptedProvider } from './testing.js';
import type { InboundMessage } from './messages.js';

describe('MockTransport', () => {
  it('throws when receive() is called before start()', async () => {
    await expect(new MockTransport().receive({ text: 'x' })).rejects.toThrow(/before start/);
  });

  it('applies the documented defaults, with ids incrementing per instance', async () => {
    const transport = new MockTransport();
    const seen: InboundMessage[] = [];
    await transport.start({ onMessage: (m) => void seen.push(m) });
    const before = Date.now();
    await transport.receive({ text: 'one' });
    await transport.receive({ text: 'two' });

    expect(seen[0]).toMatchObject({
      id: 'msg-1',
      chatId: 'test-chat',
      senderId: 'test-chat',
      isGroup: false,
      fromMe: false,
      text: 'one',
    });
    expect(seen[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(seen[1]!.id).toBe('msg-2');
  });

  it('defaults senderId to the provided chatId', async () => {
    const transport = new MockTransport();
    const seen: InboundMessage[] = [];
    await transport.start({ onMessage: (m) => void seen.push(m) });
    await transport.receive({ chatId: 'custom', text: 'x' });
    expect(seen[0]!.senderId).toBe('custom');
  });

  it('lets explicit fields win over defaults', async () => {
    const transport = new MockTransport();
    const seen: InboundMessage[] = [];
    await transport.start({ onMessage: (m) => void seen.push(m) });
    await transport.receive({
      id: 'custom-id',
      chatId: 'group-1',
      senderId: 'member-9',
      isGroup: true,
      fromMe: true,
      timestamp: 42,
      text: 'hi',
    });
    expect(seen[0]).toEqual({
      id: 'custom-id',
      chatId: 'group-1',
      senderId: 'member-9',
      isGroup: true,
      fromMe: true,
      timestamp: 42,
      text: 'hi',
    });
  });

  it('receive() awaits the full async onMessage pipeline', async () => {
    const transport = new MockTransport();
    let finished = false;
    await transport.start({
      onMessage: async () => {
        await new Promise((r) => setTimeout(r, 10));
        finished = true;
      },
    });
    await transport.receive({ text: 'x' });
    expect(finished).toBe(true);
  });

  it('records everything sent, normalized to payloads, and reports ready on start', async () => {
    const transport = new MockTransport();
    let ready: { selfId?: string } | undefined;
    await transport.start({ onMessage: () => {}, onReady: (info) => (ready = info) });
    await transport.send('a', 'plain');
    await transport.send('b', { text: 'rich', replyTo: 'm1' });
    expect(transport.sent).toEqual([
      { chatId: 'a', payload: { text: 'plain' } },
      { chatId: 'b', payload: { text: 'rich', replyTo: 'm1' } },
    ]);
    expect(ready).toEqual({ selfId: 'mock' });
  });
});

describe('ScriptedProvider', () => {
  it('expands string entries to full stop results', async () => {
    const provider = new ScriptedProvider(['hello']);
    await expect(provider.generate({ messages: [] })).resolves.toEqual({
      text: 'hello',
      toolCalls: [],
      finishReason: 'stop',
    });
  });

  it('completes partial entries, inferring finishReason from toolCalls', async () => {
    const call = { id: 'c1', name: 't', arguments: {} };
    const provider = new ScriptedProvider([{ toolCalls: [call] }, { text: 'done' }]);
    await expect(provider.generate({ messages: [] })).resolves.toEqual({
      text: null,
      toolCalls: [call],
      finishReason: 'tool_calls',
    });
    await expect(provider.generate({ messages: [] })).resolves.toEqual({
      text: 'done',
      toolCalls: [],
      finishReason: 'stop',
    });
  });

  it('lets explicit fields win over completion defaults', async () => {
    const provider = new ScriptedProvider([
      { text: 'cut off', finishReason: 'length', usage: { inputTokens: 5, outputTokens: 7 } },
    ]);
    await expect(provider.generate({ messages: [] })).resolves.toEqual({
      text: 'cut off',
      toolCalls: [],
      finishReason: 'length',
      usage: { inputTokens: 5, outputTokens: 7 },
    });
  });

  it('records every request in order', async () => {
    const provider = new ScriptedProvider(['a', 'b']);
    await provider.generate({ system: 's1', messages: [{ role: 'user', content: 'one' }] });
    await provider.generate({ system: 's2', messages: [{ role: 'user', content: 'two' }] });
    expect(provider.calls.map((c) => c.system)).toEqual(['s1', 's2']);
  });

  it('rejects loudly when the script is exhausted', async () => {
    const provider = new ScriptedProvider(['only one']);
    await provider.generate({ messages: [] });
    await expect(provider.generate({ messages: [] })).rejects.toThrow(
      'ScriptedProvider: script exhausted (call 2 of 1)'
    );
    const empty = new ScriptedProvider([]);
    await expect(empty.generate({ messages: [] })).rejects.toThrow(
      'ScriptedProvider: script exhausted (call 1 of 0)'
    );
  });
});

describe('ScriptedProvider providerData', () => {
  it('passes a providerData entry through to the result', async () => {
    const provider = new ScriptedProvider([
      { text: 'hi', providerData: { kept: true } },
      'plain',
    ]);
    const first = await provider.generate({ messages: [] });
    const second = await provider.generate({ messages: [] });
    expect(first.providerData).toEqual({ kept: true });
    expect('providerData' in second).toBe(false);
  });
});
