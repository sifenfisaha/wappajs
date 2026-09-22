import type { InboundMessage } from './messages.js';
import type {
  ChatMessage,
  GenerateRequest,
  Provider,
  SystemParts,
  ToolCall,
  ToolSpec,
} from './provider.js';
import type { Tool } from './tool.js';
import type { Context } from './context.js';

/** Configuration for {@link Agent}. */
export interface AgentOptions {
  /**
   * System prompt. Function form is re-evaluated per message. When `knowledge` is also
   * set, this is the part that may change from message to message; it is sent after
   * the knowledge.
   */
  instructions: string | ((ctx: Context) => string | Promise<string>);
  /**
   * The part of the system prompt that does not change from one message to the next:
   * the policy, a product catalogue, an FAQ, the long material. It is sent before
   * `instructions`, and providers that support prompt caching cache it, so put every
   * stable byte here and keep what varies (the time, the customer's name) in
   * `instructions`. Function form is re-evaluated per message like `instructions`, so
   * it can be refreshed from a database on your own schedule; the cache holds for as
   * long as the text comes back identical.
   */
  knowledge?: string | ((ctx: Context) => string | Promise<string>);
  provider: Provider;
  tools?: Tool[];
  /** Max provider round-trips per inbound message (tool loop cap). Default 8. */
  maxTurns?: number;
  /** History window: max ChatMessages kept in session history. Default 40. */
  maxHistoryMessages?: number;
  /**
   * History size cap: max total content chars kept/sent after the count trim. While the
   * window exceeds it, the OLDEST whole user-turn group is dropped (never splitting
   * assistant-toolCalls/tool groups, always keeping at least the final user message).
   * Prevents unbounded per-message payloads (huge pasted texts) from permanently
   * exceeding the model context — failed turns roll back, so an oversized window would
   * otherwise be retried forever. Default 200_000.
   */
  maxHistoryChars?: number;
  /** Default 1024. */
  maxTokens?: number;
  /** Omitted from requests unless set. */
  temperature?: number;
}

/** The system prompt as sent: the whole text, plus its two parts when there is knowledge. */
interface SystemPrompt {
  system: string;
  systemParts?: SystemParts;
}

/**
 * Render the inbound message as user-message text: text if present; media →
 * `[image]`/`[voice note]`/etc placeholder plus caption; location → `[location: lat, lon]`.
 * In groups, prefixed with `senderName || senderId` + `: `.
 */
function renderUserMessage(msg: InboundMessage): string {
  let body: string;
  if (msg.media) {
    const placeholder =
      msg.media.kind === 'audio' && msg.media.ptt ? '[voice note]' : `[${msg.media.kind}]`;
    body = msg.text ? `${placeholder} ${msg.text}` : placeholder;
  } else if (msg.text) {
    body = msg.text;
  } else if (msg.location) {
    body = `[location: ${msg.location.latitude}, ${msg.location.longitude}]`;
  } else {
    body = '';
  }
  return msg.isGroup ? `${msg.senderName || msg.senderId}: ${body}` : body;
}

/**
 * Knowledge first, then instructions, separated by a blank line. `systemParts` is set
 * only when there is knowledge, so a provider can tell a split prompt from a plain one.
 */
function composeSystem(knowledge: string | undefined, instructions: string): SystemPrompt {
  if (knowledge === undefined) return { system: instructions };
  const system = instructions ? `${knowledge}\n\n${instructions}` : knowledge;
  return { system, systemParts: { stable: knowledge, dynamic: instructions } };
}

/**
 * Trim history to at most `max` messages and at most `maxChars` total content chars.
 * The count window is aligned forward to the next `user` message — providers reject
 * histories that open with an assistant or tool message — which also keeps
 * assistant-toolCalls/tool-results groups whole (a group at the window edge is dropped,
 * never split). If aligning empties the window (e.g. one tool group larger than the
 * window), the slice falls back to the LAST user message in history so every request
 * still carries the current user turn. The char cap then drops the OLDEST whole
 * user-turn group while over budget, always keeping at least the final user message.
 * Returns the same array when no trimming is needed.
 */
function trimHistory(history: ChatMessage[], max: number, maxChars: number): ChatMessage[] {
  let start = 0;
  if (history.length > max) {
    start = history.length - max;
    while (start < history.length && history[start]!.role !== 'user') start++;
    if (start >= history.length) {
      // The count window holds no user message: fall back to the last user message.
      start = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]!.role === 'user') {
          start = i;
          break;
        }
      }
      if (start < 0) {
        // No user message anywhere (never produced by Agent.run): old behavior.
        start = history.length - max;
        while (start < history.length && history[start]!.role === 'tool') start++;
      }
    }
  }
  let window = start > 0 ? history.slice(start) : history;
  let total = 0;
  for (const m of window) total += m.content.length;
  while (total > maxChars) {
    let next = 1;
    while (next < window.length && window[next]!.role !== 'user') next++;
    if (next >= window.length) break; // only the final user turn remains — keep it
    for (let i = 0; i < next; i++) total -= window[i]!.content.length;
    window = window.slice(next);
  }
  return window;
}

/**
 * The provider-agnostic agentic loop: renders the inbound message, calls the provider,
 * executes requested tools, and maintains windowed session history. Does NOT send the
 * reply — Bot does. Session persistence is Bot's job.
 */
export class Agent {
  private readonly instructions: AgentOptions['instructions'];
  private readonly knowledge: AgentOptions['knowledge'];
  private readonly provider: Provider;
  private readonly tools: Map<string, Tool>;
  private readonly toolSpecs: ToolSpec[];
  private readonly maxTurns: number;
  private readonly maxHistoryMessages: number;
  private readonly maxHistoryChars: number;
  private readonly maxTokens: number;
  private readonly temperature: number | undefined;

  constructor(opts: AgentOptions) {
    this.instructions = opts.instructions;
    this.knowledge = opts.knowledge;
    this.provider = opts.provider;
    this.tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    this.toolSpecs = (opts.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    this.maxTurns = opts.maxTurns ?? 8;
    this.maxHistoryMessages = opts.maxHistoryMessages ?? 40;
    this.maxHistoryChars = opts.maxHistoryChars ?? 200_000;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.temperature = opts.temperature;
  }

  private buildRequest(prompt: SystemPrompt, history: ChatMessage[], withTools: boolean): GenerateRequest {
    const req: GenerateRequest = {
      system: prompt.system,
      messages: [...trimHistory(history, this.maxHistoryMessages, this.maxHistoryChars)],
      maxTokens: this.maxTokens,
    };
    if (prompt.systemParts) req.systemParts = prompt.systemParts;
    if (withTools && this.toolSpecs.length > 0) req.tools = this.toolSpecs;
    if (this.temperature !== undefined) req.temperature = this.temperature;
    return req;
  }

  /** Evaluate `knowledge` and `instructions` for this message and compose the prompt. */
  private async systemFor(ctx: Context): Promise<SystemPrompt> {
    const instructions =
      typeof this.instructions === 'function' ? await this.instructions(ctx) : this.instructions;
    const knowledge =
      this.knowledge === undefined
        ? undefined
        : typeof this.knowledge === 'function'
          ? await this.knowledge(ctx)
          : this.knowledge;
    return composeSystem(knowledge, instructions);
  }

  /** Execute one requested tool call; never throws (unknown tools and failures become result strings). */
  private async executeToolCall(call: ToolCall, ctx: Context): Promise<string> {
    const tool = this.tools.get(call.name);
    if (!tool) return `Error: unknown tool ${call.name}`;
    return tool.invoke(call.arguments, ctx);
  }

  /**
   * Run one agentic turn for ctx.message: append the rendered user message, loop
   * provider.generate + tool execution (up to maxTurns; then one final no-tools call),
   * append the final assistant text if any, trim history, and return the final text
   * (null if none). On any error the session history is restored to its pre-run
   * snapshot before the error propagates — a failed turn is never persisted.
   */
  async run(ctx: Context): Promise<string | null> {
    const snapshot = ctx.session.history.slice();
    try {
      const prompt = await this.systemFor(ctx);

      const history = ctx.session.history;
      history.push({ role: 'user', content: renderUserMessage(ctx.message) });

      let finalText: string | null = null;
      let finalData: unknown;
      let settled = false;

      for (let turn = 0; turn < this.maxTurns; turn++) {
        const result = await this.provider.generate(this.buildRequest(prompt, history, true));
        if (result.toolCalls.length === 0) {
          finalText = result.text;
          finalData = result.providerData;
          settled = true;
          break;
        }
        const assistant: ChatMessage = {
          role: 'assistant',
          content: result.text ?? '',
          toolCalls: result.toolCalls,
        };
        if (result.providerData !== undefined) assistant.providerData = result.providerData;
        history.push(assistant);
        for (const call of result.toolCalls) {
          const content = await this.executeToolCall(call, ctx);
          history.push({ role: 'tool', content, toolCallId: call.id, toolName: call.name });
        }
      }

      if (!settled) {
        // maxTurns hit while the model still wants tools: force a text answer.
        const result = await this.provider.generate(this.buildRequest(prompt, history, false));
        finalText = result.text;
        finalData = result.providerData;
      }

      if (finalText) {
        const assistant: ChatMessage = { role: 'assistant', content: finalText };
        if (finalData !== undefined) assistant.providerData = finalData;
        history.push(assistant);
      }
      ctx.session.history = trimHistory(history, this.maxHistoryMessages, this.maxHistoryChars);
      return finalText || null;
    } catch (err) {
      ctx.session.history = snapshot;
      throw err;
    }
  }
}
