/**
 * Testing utilities, exported as `@wappajs/core/testing`: unit-test bots without WhatsApp
 * or an LLM key.
 */
import type {
  InboundMessage,
  OutboundContent,
  OutboundPayload,
  SendResult,
} from './messages.js';
import { toPayload } from './messages.js';
import type { Transport, TransportHandlers } from './transport.js';
import type { GenerateRequest, GenerateResult, Provider } from './provider.js';

/** In-memory transport for tests. */
export class MockTransport implements Transport {
  readonly name = 'mock' as const;
  /** Everything sent via send(), in order. */
  readonly sent: Array<{ chatId: string; payload: OutboundPayload }> = [];

  private handlers: TransportHandlers | undefined;
  private counter = 0;

  async start(h: TransportHandlers): Promise<void> {
    this.handlers = h;
    h.onReady?.({ selfId: 'mock' });
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
  }

  async send(chatId: string, content: OutboundContent): Promise<SendResult> {
    this.sent.push({ chatId, payload: toPayload(content) });
    return { id: `mock-sent-${this.sent.length}` };
  }

  /**
   * Simulate an inbound message; returns once the pipeline (incl. async handling)
   * settles. Defaults (exact, so user tests can assert on them): chatId 'test-chat',
   * senderId = chatId, id 'msg-<n>' (incrementing per transport instance),
   * timestamp Date.now(), isGroup false, fromMe false.
   */
  async receive(partial: Partial<InboundMessage> & { text?: string }): Promise<void> {
    if (!this.handlers) {
      throw new Error('MockTransport: receive() called before start()');
    }
    const n = ++this.counter;
    const overrides = Object.fromEntries(
      Object.entries(partial).filter(([, v]) => v !== undefined)
    ) as Partial<InboundMessage>;
    const msg: InboundMessage = {
      id: `msg-${n}`,
      chatId: 'test-chat',
      senderId: partial.chatId ?? 'test-chat',
      timestamp: Date.now(),
      isGroup: false,
      fromMe: false,
      ...overrides,
    };
    await this.handlers.onMessage(msg);
  }
}

/** Provider that replays scripted results; records every GenerateRequest. */
export class ScriptedProvider implements Provider {
  readonly name = 'scripted' as const;
  /** Every request generate() received, in order. */
  readonly calls: GenerateRequest[] = [];

  private readonly script: GenerateResult[];
  private cursor = 0;

  /**
   * string s === { text: s, toolCalls: [], finishReason: 'stop' }.
   * Partial entries are completed with { text: null, toolCalls: [],
   * finishReason: toolCalls.length ? 'tool_calls' : 'stop' } (explicit fields win).
   * A `providerData` entry is passed through, so tests can check the Agent keeps it.
   * generate() past the end of the script rejects with
   * Error('ScriptedProvider: script exhausted (call <n> of <len>)') — loops fail loudly.
   */
  constructor(script: Array<Partial<GenerateResult> | string>) {
    this.script = script.map((entry) => {
      if (typeof entry === 'string') {
        return { text: entry, toolCalls: [], finishReason: 'stop' as const };
      }
      const toolCalls = entry.toolCalls ?? [];
      const result: GenerateResult = {
        text: entry.text ?? null,
        toolCalls,
        finishReason: entry.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      };
      if (entry.usage !== undefined) result.usage = entry.usage;
      if (entry.providerData !== undefined) result.providerData = entry.providerData;
      return result;
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    if (this.cursor >= this.script.length) {
      throw new Error(
        `ScriptedProvider: script exhausted (call ${this.calls.length} of ${this.script.length})`
      );
    }
    const result = this.script[this.cursor++]!;
    return { ...result, toolCalls: [...result.toolCalls] };
  }
}
