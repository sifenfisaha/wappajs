/**
 * Twilio WhatsApp (BSP) transport: form-encoded webhook (inbound) + Messages
 * REST API with basic auth (outbound). Uses only node:http, node:crypto and the
 * global fetch — no Twilio SDK.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  consoleLogger,
  toPayload,
  type Logger,
  type OutboundContent,
  type SendResult,
  type Transport,
  type TransportHandlers,
} from '@wappajs/core';
import {
  buildSendParams,
  ensureWhatsappPrefix,
  isStatusCallback,
  mapTwilioParams,
  type TwilioParams,
} from './mapping.js';
import { DEFAULT_MAX_BODY_BYTES, parseFormBody, readRawBody, verifyTwilioSignature } from './webhook.js';

/** Cap on the redelivery-dedup MessageSid set. */
const TRACKING_CAP = 1000;

/** Empty TwiML: acknowledges the webhook while telling Twilio to send no auto-reply. */
const EMPTY_TWIML = '<Response/>';

/** Configuration for {@link TwilioTransport}. */
export interface TwilioTransportOptions {
  /** Twilio account SID (ACxxxx). */
  accountSid: string;
  /** Auth token — used for basic auth AND webhook signature validation. */
  authToken: string;
  /** Your Twilio WhatsApp sender, with or without the 'whatsapp:' prefix. */
  whatsappNumber: string;
  /** If set, transport starts its own node:http server on this port (0 = ephemeral, see {@link TwilioTransport.httpServer}). */
  port?: number;
  /** Webhook path. Default '/webhook'. */
  webhookPath?: string;
  /**
   * The exact public URL Twilio POSTs to (scheme + host + path), used for
   * X-Twilio-Signature validation. STRONGLY recommended behind proxies/tunnels;
   * if omitted, reconstructed as 'https://' + Host header + path (log a warning once).
   */
  webhookUrl?: string;
  /** Disable signature validation (tests only). Default true. */
  validateSignature?: boolean;
  /** Twilio REST API origin. Default 'https://api.twilio.com' (override for tests). */
  apiBaseUrl?: string;
  logger?: Logger;
}

/**
 * Twilio WhatsApp {@link Transport}.
 *
 * Inbound messages arrive via the Twilio webhook: either let the transport run
 * its own node:http server (set `port`) or mount
 * {@link TwilioTransport.handleRequest} into an existing server. Outbound
 * messages go through the Twilio Messages REST API with `fetch` + basic auth.
 *
 * Twilio WhatsApp is DM-only: mapped messages always have `isGroup: false` and
 * `chatId === senderId` (the `whatsapp:+E164` sender address, verbatim).
 * `sendTyping`/`markRead` are deliberately absent — Twilio does not expose them
 * for WhatsApp, and Bot feature-detects the missing methods.
 */
export class TwilioTransport implements Transport {
  readonly name = 'twilio' as const;

  private readonly accountSid: string;
  private readonly authToken: string;
  /** The configured sender, normalized to its whatsapp:-prefixed form. */
  private readonly fromNumber: string;
  private readonly port: number | undefined;
  private readonly webhookPath: string;
  private readonly webhookUrl: string | undefined;
  private readonly validateSignature: boolean;
  private readonly apiBaseUrl: string;
  private readonly logger: Logger;

  private handlers: TransportHandlers | undefined;
  private server: Server | undefined;
  private stopped = false;
  private warnedNoValidation = false;
  private warnedReconstructedUrl = false;
  /**
   * Recently seen inbound MessageSids, insertion-ordered. Twilio retries
   * webhooks it considers failed, so redelivered sids are skipped to avoid
   * duplicate agent turns. Bounded to {@link TRACKING_CAP} ids (oldest evicted first).
   */
  private readonly seenMessageSids = new Set<string>();

  constructor(opts: TwilioTransportOptions) {
    if (!opts?.accountSid) throw new Error('TwilioTransport: accountSid is required');
    if (!opts.authToken) throw new Error('TwilioTransport: authToken is required');
    if (!opts.whatsappNumber) throw new Error('TwilioTransport: whatsappNumber is required');
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.fromNumber = ensureWhatsappPrefix(opts.whatsappNumber);
    this.port = opts.port;
    const path = opts.webhookPath ?? '/webhook';
    this.webhookPath = path.startsWith('/') ? path : `/${path}`;
    // `|| undefined` so an empty string (e.g. `TWILIO_WEBHOOK_URL=` via --env-file)
    // falls back to Host-header reconstruction instead of signing over ''.
    this.webhookUrl = opts.webhookUrl || undefined;
    this.validateSignature = opts.validateSignature ?? true;
    this.apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '');
    this.logger = opts.logger ?? consoleLogger();
  }

  /**
   * The internally-started HTTP server when `port` was configured (undefined
   * otherwise, and before start). With `port: 0` read the actual ephemeral port
   * from `httpServer.address()`.
   */
  get httpServer(): Server | undefined {
    return this.server;
  }

  /**
   * Register handlers and (when `port` is set) start the internal node:http
   * server, routing every request through {@link handleRequest} and answering
   * 404 for unmatched paths. Without `port` this only validates config — mount
   * `handleRequest` into your own server. Fires `onReady` with
   * `selfId` = the whatsapp:-prefixed sender number.
   */
  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    if (!this.validateSignature && !this.warnedNoValidation) {
      this.warnedNoValidation = true;
      this.logger.warn(
        'twilio: signature validation is DISABLED (validateSignature: false) — anyone who discovers the webhook URL can forge inbound messages; use only in tests',
      );
    }
    if (this.port !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const server = createServer((req, res) => {
          void this.route(req, res);
        });
        server.once('error', reject);
        server.listen(this.port, () => {
          server.off('error', reject);
          this.server = server;
          resolve();
        });
      });
      this.logger.info('twilio: webhook server listening', {
        port: this.port,
        path: this.webhookPath,
      });
    }
    handlers.onReady?.({ selfId: this.fromNumber });
  }

  /** Stop delivering events and close the internal server (if any). Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    }
  }

  /**
   * Mount into an existing Node http(s) server: handles Twilio webhook POSTs.
   * Returns true if the request was handled (path matched). Reads the raw body
   * itself UNLESS `rawBody` is provided — pass `rawBody` when a framework
   * body-parser already consumed the stream (Express: mount `express.raw()`
   * with a wildcard `type` option on the webhook path and pass `req.body`).
   * The signature check runs over the decoded params of these exact raw bytes.
   *
   * Valid requests are acknowledged with 200 + empty TwiML (`<Response/>`, so
   * Twilio sends no auto-reply) BEFORE any processing; an invalid or missing
   * X-Twilio-Signature answers 403 and processes nothing.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse, rawBody?: Buffer): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== this.webhookPath) return false;

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('allow', 'POST');
      res.end('Method Not Allowed');
      return true;
    }

    let raw: Buffer;
    try {
      raw = rawBody ?? (await readRawBody(req));
    } catch (err) {
      this.logger.warn('twilio: failed to read webhook body', { error: String(err) });
      res.statusCode = 400;
      res.end('Bad Request');
      return true;
    }
    const params = parseFormBody(raw);

    if (this.validateSignature) {
      const header = req.headers['x-twilio-signature'];
      const signature = Array.isArray(header) ? header[0] : header;
      const signedUrl = this.webhookUrl ?? this.reconstructUrl(req);
      if (!this.signatureOk(params, signature, signedUrl)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return true;
      }
    }

    // Acknowledge immediately (Twilio retries slow webhooks), then process async.
    res.statusCode = 200;
    res.setHeader('content-type', 'text/xml');
    res.end(EMPTY_TWIML);
    this.processWebhook(params);
    return true;
  }

  /**
   * Fetch-style twin of {@link handleRequest}, for runtimes and frameworks that
   * speak WHATWG `Request`/`Response`: Bun, Deno, Cloudflare Workers, Hono,
   * Next.js route handlers, SvelteKit, Remix. Path routing is the host's job —
   * every request handed in is treated as the webhook (there is no
   * `webhookPath` check). The semantics match `handleRequest`: 405 for
   * anything but POST, 400 for an unreadable or oversized body, 403 for a
   * missing or invalid `X-Twilio-Signature` (checked against `webhookUrl`, or
   * reconstructed from the request's own URL when unset — see the proxy
   * caveat), and 200 + empty TwiML for a valid post, with the message
   * delivered after the response is returned.
   */
  async handleFetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
    }
    let raw: Buffer;
    try {
      raw = Buffer.from(await request.arrayBuffer());
    } catch (err) {
      this.logger.warn('twilio: failed to read webhook body', { error: String(err) });
      return new Response('Bad Request', { status: 400 });
    }
    if (raw.length > DEFAULT_MAX_BODY_BYTES) {
      this.logger.warn('twilio: webhook body exceeded the size cap', { bytes: raw.length });
      return new Response('Bad Request', { status: 400 });
    }
    const params = parseFormBody(raw);
    if (this.validateSignature) {
      const signedUrl = this.webhookUrl ?? this.reconstructFetchUrl(request);
      const signature = request.headers.get('x-twilio-signature') ?? undefined;
      if (!this.signatureOk(params, signature, signedUrl)) {
        return new Response('Forbidden', { status: 403 });
      }
    }
    this.processWebhook(params);
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'content-type': 'text/xml' } });
  }

  /**
   * Send a message to `chatId` via the Twilio Messages API. The `whatsapp:`
   * prefix is prepended when missing, so inbound chat ids round-trip verbatim.
   * Outbound media must be a public http(s) URL (Twilio has no binary upload
   * for messaging — a Buffer or local path throws); buttons render as a
   * numbered text fallback. Non-2xx responses throw with status + body.
   */
  async send(chatId: string, content: OutboundContent): Promise<SendResult> {
    const body = buildSendParams(chatId, this.fromNumber, toPayload(content), this.logger);
    const res = await fetch(
      `${this.apiBaseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: { ...this.authHeader(), 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Twilio Messages API request failed with status ${res.status}: ${text}`);
    }
    let sid: string | undefined;
    try {
      sid = (JSON.parse(text) as { sid?: string }).sid;
    } catch {
      /* tolerate a non-JSON 2xx body */
    }
    return { id: sid };
  }

  // ---------------------------------------------------------------- internals

  private authHeader(): Record<string, string> {
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    return { authorization: `Basic ${credentials}` };
  }

  /** Internal-server request router (only used when `port` is configured). */
  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const handled = await this.handleRequest(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end('Not Found');
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.logger.error('twilio: error handling webhook request', { error: e.message });
      this.handlers?.onError?.(e);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  }

  /**
   * Reconstruct the URL Twilio signed from the Host header when `webhookUrl` is
   * not configured. Behind a proxy/tunnel that rewrites Host (or terminates TLS
   * on a different path) this can mismatch what Twilio actually signed — warn once.
   */
  private signatureOk(params: TwilioParams, signature: string | undefined, signedUrl: string): boolean {
    if (verifyTwilioSignature(this.authToken, signedUrl, params, signature)) return true;
    this.logger.warn('twilio: rejected webhook POST with missing or invalid X-Twilio-Signature', {
      url: signedUrl,
    });
    return false;
  }

  /** The fetch-style counterpart of {@link reconstructUrl}: Host header (or the URL's host) + path + query. */
  private reconstructFetchUrl(request: Request): string {
    const url = new URL(request.url);
    return this.warnReconstructed(
      `https://${request.headers.get('host') ?? url.host}${url.pathname}${url.search}`,
    );
  }

  private reconstructUrl(req: IncomingMessage): string {
    return this.warnReconstructed(`https://${req.headers.host ?? 'localhost'}${req.url ?? this.webhookPath}`);
  }

  /** Warn once that the signed URL is being guessed rather than configured. */
  private warnReconstructed(url: string): string {
    if (!this.warnedReconstructedUrl) {
      this.warnedReconstructedUrl = true;
      this.logger.warn(
        'twilio: webhookUrl is not configured — reconstructing it from the Host header for signature validation; behind a proxy/tunnel this can mismatch what Twilio signed, so set webhookUrl to the exact public URL',
        { reconstructed: url },
      );
    }
    return url;
  }

  /**
   * Map one webhook param bag and deliver it to onMessage WITHOUT awaiting the
   * handler: Bot's per-chat queue already preserves per-chat order (its enqueue
   * is synchronous), and awaiting here would let one chat's slow agent turn
   * block the webhook loop. Status callbacks are ignored, and redelivered
   * MessageSids (Twilio retries failed webhooks) are skipped.
   */
  private processWebhook(params: TwilioParams): void {
    if (this.stopped || !this.handlers) return;
    if (isStatusCallback(params)) {
      this.logger.debug('twilio: ignoring status callback', {
        sid: params.MessageSid,
        status: params.MessageStatus ?? params.SmsStatus,
      });
      return;
    }
    const msg = mapTwilioParams(params, {
      downloadMedia: (url) => this.downloadMedia(url),
      logger: this.logger,
    });
    if (!msg) return;
    if (this.seenMessageSids.has(msg.id)) {
      this.logger.debug('twilio: skipping redelivered message', { id: msg.id });
      return;
    }
    this.rememberSeen(msg.id);
    const handlers = this.handlers;
    void Promise.resolve()
      .then(() => handlers.onMessage(msg))
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        if (handlers.onError) handlers.onError(e);
        else this.logger.error('twilio: onMessage handler failed', { error: e.message });
      });
  }

  /** Record a delivered MessageSid for redelivery dedup, evicting the oldest past the cap. */
  private rememberSeen(messageSid: string): void {
    this.seenMessageSids.add(messageSid);
    if (this.seenMessageSids.size > TRACKING_CAP) {
      const oldest = this.seenMessageSids.values().next().value;
      if (oldest !== undefined) this.seenMessageSids.delete(oldest);
    }
  }

  /** GET a Twilio media URL, following redirects to the CDN; returns the bytes. */
  private async downloadMedia(url: string): Promise<Buffer> {
    // Credentials are pinned to the Twilio API origin: MediaUrl values come from the
    // webhook payload, so never send the account's basic auth to any other host.
    const sameOrigin = new URL(url).origin === new URL(this.apiBaseUrl).origin;
    const res = await fetch(url, {
      headers: sameOrigin ? this.authHeader() : {},
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`Twilio media download failed with status ${res.status}: ${await res.text()}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
