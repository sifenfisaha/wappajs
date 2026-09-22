/**
 * Provider-agnostic LLM interface. The core owns the tool-call loop and conversation
 * memory; providers only map one `generate()` call to their SDK.
 *
 * There is no `system` role in {@link ChatMessage}: the system prompt travels separately
 * in {@link GenerateRequest.system} because every provider treats it specially.
 */

/** Conversation roles stored in session history. */
export type Role = 'user' | 'assistant' | 'tool';

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** One message in the provider-agnostic conversation history. */
export interface ChatMessage {
  role: Role;
  /** Text content. Empty string allowed (e.g. assistant message that only calls tools). */
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on role 'tool' messages. */
  toolCallId?: string;
  toolName?: string;
  /**
   * Opaque, provider-owned data on an assistant message: whatever the provider needs
   * to replay that turn exactly as its API produced it. `@wappajs/anthropic` keeps the
   * response's content blocks here so the model's thinking blocks survive the tool
   * loop, which the Messages API requires. The core never reads it: the Agent copies
   * it from {@link GenerateResult.providerData} onto the message it appends, the
   * session store persists it with the history, and it comes back to the provider
   * inside `messages`. Must be JSON-serializable.
   */
  providerData?: unknown;
}

/** JSON Schema object for tool parameters. */
export type JsonSchema = Record<string, unknown>;

/** Provider-facing tool description. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * The system prompt split in two: the part that does not change from one message to
 * the next, and the part that does. See {@link GenerateRequest.systemParts}.
 */
export interface SystemParts {
  /** The agent's `knowledge`: identical on every message of a chat. */
  stable: string;
  /** This message's `instructions`. May be empty. */
  dynamic: string;
}

/** One `generate()` call: system prompt, windowed history, tool specs, sampling options. */
export interface GenerateRequest {
  /** The complete system prompt: the agent's knowledge (when it has any), then its instructions. */
  system?: string;
  /**
   * The same prompt in two parts, present only when the agent has `knowledge`. A
   * provider that supports prompt caching caches the stable part (`@wappajs/anthropic`
   * marks it with a cache breakpoint); a provider that does not can ignore this field,
   * since `system` already carries both parts in the same order.
   */
  systemParts?: SystemParts;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

/** Normalized model output for one `generate()` call. */
export interface GenerateResult {
  /** Final assistant text, or null if the model only called tools. */
  text: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number };
  /**
   * Copied by the Agent onto the assistant message it appends for this result, so the
   * provider sees it again on the next call. See {@link ChatMessage.providerData}.
   */
  providerData?: unknown;
}

/** An LLM backend. Implementations map one request/response pair to their SDK. */
export interface Provider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
