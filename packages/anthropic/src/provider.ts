/**
 * Claude provider for wappa: maps one {@link GenerateRequest} to a single
 * Anthropic Messages API call.
 */
import { Anthropic } from '@anthropic-ai/sdk';
import {
  consoleLogger,
  type GenerateRequest,
  type GenerateResult,
  type Logger,
  type Provider,
} from '@wappajs/core';
import {
  degradeToolHistory,
  fromAnthropicResponse,
  toAnthropicMessages,
  toAnthropicTools,
} from './mapping.js';

/**
 * Model-id prefixes for which the API REMOVED sampling params
 * (`temperature`/`top_p`/`top_k`) — sending them returns 400.
 */
const SAMPLING_REJECTING_MODEL_PREFIXES = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-5',
];

/**
 * The slice of the Anthropic client the provider uses. The real `Anthropic`
 * instance satisfies it structurally; tests inject a fake.
 * @internal
 */
export interface AnthropicClientLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** How much the model thinks per reply — the Messages API's `output_config.effort`. */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Options for {@link AnthropicProvider}. */
export interface AnthropicProviderOptions {
  /** Anthropic API key. Default: `ANTHROPIC_API_KEY` env var (SDK default). */
  apiKey?: string;
  /**
   * Model id. Default `'claude-sonnet-5'`.
   *
   * Sampling params (`temperature`/`top_p`/`top_k`) are REMOVED from the
   * current model generation — `claude-fable-5`, `claude-mythos-5`,
   * `claude-opus-5`, `claude-opus-4-7`, `claude-opus-4-8` and
   * `claude-sonnet-5` (the default) return 400 when they are sent. For those
   * models the provider drops `temperature` and warns once per instance;
   * `claude-opus-4-6`, `claude-sonnet-4-6` and older models (4.5 family,
   * haiku) still receive it.
   */
  model?: string;
  /**
   * How much thinking the model does per reply, sent as `output_config.effort`.
   * The API default is `'high'`; chat replies are usually best served at
   * `'low'` or `'medium'`, which answer faster and cost less. Omitted unless
   * set. Models older than the 4.6 generation reject it.
   */
  effort?: AnthropicEffort;
  /**
   * The `thinking` request parameter, passed through as given — for example
   * `{ type: 'adaptive' }` to turn adaptive thinking on for a model that
   * leaves it off by default, or `{ type: 'disabled' }` where the model allows
   * that. Omitted unless set; the current models think adaptively by default.
   * The thinking blocks a model produces are kept on the session as the
   * assistant message's `providerData` and replayed unchanged on later calls,
   * which the API requires inside a tool loop.
   */
  thinking?: Anthropic.ThinkingConfigParam;
  /**
   * Merged into every request after the provider's own fields — the escape
   * hatch for Messages API parameters the provider does not model
   * (`metadata`, `stop_sequences`, `service_tier`, ...). A beta feature needs
   * its header too: set `clientOptions.defaultHeaders['anthropic-beta']`.
   */
  extraParams?: Record<string, unknown>;
  /** Extra options passed to the Anthropic CLIENT CONSTRUCTOR (baseURL, timeout, ...). */
  clientOptions?: ConstructorParameters<typeof Anthropic>[0];
  /**
   * Logger for adapter diagnostics (e.g. dropped sampling params).
   * Default: `consoleLogger()`.
   */
  logger?: Logger;
  /**
   * Pre-built client used instead of constructing one. Test injection point —
   * not part of the public API.
   * @internal
   */
  client?: AnthropicClientLike;
}

/**
 * Anthropic (Claude) LLM provider.
 *
 * Request mapping: `system` → `system` — as a plain string, or, when the agent
 * has `knowledge`, as two text blocks with a cache breakpoint after the stable
 * one, so the knowledge is read from the prompt cache on every call;
 * `maxTokens` → `max_tokens` (the API requires it — defaults to 1024 when
 * unset); `effort` → `output_config.effort` and `thinking` → `thinking`, each
 * only when set; `temperature` forwarded only when set AND the model still
 * supports it (current-generation models reject sampling params — see
 * {@link AnthropicProviderOptions.model} — so it is dropped for them with a
 * one-time warning); history and tools via the pure helpers in `mapping.ts`.
 * When the request has no tools but the history carries tool calls/results
 * (the agent's maxTurns-exhaustion fallback), tool blocks are degraded to
 * plain text — the API rejects `tool_use`/`tool_result` blocks without a
 * `tools` param.
 *
 * Response mapping keeps the content blocks of any turn that holds more than
 * text as the result's `providerData`, and replays them verbatim when the
 * history comes back: the thinking blocks of a tool-calling turn must be
 * returned to the API unchanged for the loop to continue.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic' as const;

  private readonly model: string;
  private readonly effort: AnthropicEffort | undefined;
  private readonly thinking: Anthropic.ThinkingConfigParam | undefined;
  private readonly extraParams: Record<string, unknown> | undefined;
  private readonly client: AnthropicClientLike;
  private readonly logger: Logger;
  private warnedTemperature = false;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.model = opts.model ?? 'claude-sonnet-5';
    this.effort = opts.effort;
    this.thinking = opts.thinking;
    this.extraParams = opts.extraParams;
    this.logger = opts.logger ?? consoleLogger();
    this.client =
      opts.client ??
      new Anthropic({
        ...opts.clientOptions,
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      });
  }

  /** Run one non-streaming `messages.create` call and normalize the result. */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const noTools = req.tools === undefined || req.tools.length === 0;
    const history =
      noTools &&
      req.messages.some((m) => m.role === 'tool' || (m.toolCalls && m.toolCalls.length > 0))
        ? degradeToolHistory(req.messages)
        : req.messages;
    const { system, messages } = toAnthropicMessages(req.system, history, req.systemParts);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: req.maxTokens ?? 1024,
      messages,
    };
    if (system !== undefined) params.system = system;
    if (req.tools !== undefined) params.tools = toAnthropicTools(req.tools);
    if (this.thinking !== undefined) params.thinking = this.thinking;
    if (this.effort !== undefined) params.output_config = { effort: this.effort };
    if (req.temperature !== undefined) {
      if (SAMPLING_REJECTING_MODEL_PREFIXES.some((prefix) => this.model.startsWith(prefix))) {
        if (!this.warnedTemperature) {
          this.warnedTemperature = true;
          this.logger.warn(
            `@wappajs/anthropic: model ${this.model} does not support temperature; ignoring`,
          );
        }
      } else {
        params.temperature = req.temperature;
      }
    }
    const request = this.extraParams
      ? ({ ...params, ...this.extraParams } as Anthropic.MessageCreateParamsNonStreaming)
      : params;
    const resp = await this.client.messages.create(request);
    if (resp.stop_reason === 'refusal') {
      this.logger.warn('@wappajs/anthropic: the model refused this turn', {
        stopDetails: resp.stop_details ?? undefined,
      });
    }
    return fromAnthropicResponse(resp);
  }
}
