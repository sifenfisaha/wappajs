/**
 * Official WhatsApp Cloud API transport: Meta webhook (inbound) + Graph API (outbound).
 * Uses only node:http, node:crypto and the global fetch/FormData/Blob — no Meta SDK.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  consoleLogger,
  toPayload,
  type Logger,
  type OutboundContent,
  type OutboundMedia,
  type SendResult,
  type Transport,
  type TransportHandlers,
} from '@wappajs/core';
import { buildSendBody, isHttpUrl, mapWebhookPayload } from './mapping.js';
import { DEFAULT_MAX_BODY_BYTES, readRawBody, verifySignature } from './webhook.js';

/** Cap on the per-chat lastInboundId map and the redelivery-dedup id set. */
const TRACKING_CAP = 1000;

/** Configuration for {@link CloudApiTransport}. */
export interface CloudApiTransportOptions {
  accessToken: string;
  phoneNumberId: string;
  /** Webhook verify token you configure in the Meta app dashboard. */
  verifyToken: string;
  /** App secret for X-Hub-Signature-256 validation. Strongly recommended; if omitted, signature is not checked (log a warning). */
  appSecret?: string;
  /** If set, transport starts its own node:http server on this port (0 = ephemeral, see {@link CloudApiTransport.httpServer}). */
  port?: number;
  /** Webhook path. Default '/webhook'. */
  webhookPath?: string;
  /** Graph API version segment. Default 'v23.0'. */
  graphApiVersion?: string;
  /** Graph API origin. Default 'https://graph.facebook.com' (override for tests). */
  baseUrl?: string;
  logger?: Logger;
}

/**
 * WhatsApp Cloud API {@link Transport}.
 *
 * Inbound messages arrive via the Meta webhook: either let the transport run its
 * own node:http server (set `port`) or mount {@link CloudApiTransport.handleRequest}
 * into an existing server. Outbound messages go through the Graph API
 * `/{phoneNumberId}/messages` endpoint with `fetch`.
 *
 * Cloud API is DM-only: mapped messages always have `isGroup: false` and
 * `chatId === senderId` (the sender's phone number).
 */
export class CloudApiTransport implements Transport {
  readonly name = 'cloud-api' as const;

  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly verifyToken: string;
  private readonly appSecret: string | undefined;
  private readonly port: number | undefined;
  private readonly webhookPath: string;
  private readonly graphApiVersion: string;
  private readonly baseUrl: string;
  private readonly logger: Logger;

  private handlers: TransportHandlers | undefined;
  private server: Server | undefined;
  private stopped = false;
  private warnedNoSecret = false;
  /**
   * Last inbound message id per chat — needed for the typing indicator.
   * Bounded to {@link TRACKING_CAP} entries (oldest chat evicted first).
   */
  private readonly lastInboundId = new Map<string, string>();
  /**
   * Recently seen inbound message ids, insertion-ordered. Meta delivers webhooks
   * at-least-once, so redelivered wamids are skipped to avoid duplicate agent
   * turns. Bounded to {@link TRACKING_CAP} ids (oldest evicted first).
   */
  private readonly seenMessageIds = new Set<string>();

  constructor(opts: CloudApiTransportOptions) {
    if (!opts?.accessToken) throw new Error('CloudApiTransport: accessToken is required');
    if (!opts.phoneNumberId) throw new Error('CloudApiTransport: phoneNumberId is required');
    if (!opts.verifyToken) throw new Error('CloudApiTransport: verifyToken is required');
    this.accessToken = opts.accessToken;
    this.phoneNumberId = opts.phoneNumberId;
    this.verifyToken = opts.verifyToken;
    this.appSecret = opts.appSecret;
    this.port = opts.port;
    const path = opts.webhookPath ?? '/webhook';
    this.webhookPath = path.startsWith('/') ? path : `/${path}`;
    this.graphApiVersion = opts.graphApiVersion ?? 'v23.0';
    this.baseUrl = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
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
   * server, routing every request through {@link handleRequest} and answering 404
   * for unmatched paths. Without `port` this only validates config — mount
   * `handleRequest` into your own server. Fires `onReady` with
   * `selfId = phoneNumberId`.
   */
  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    if (!this.appSecret && !this.warnedNoSecret) {
      this.warnedNoSecret = true;
      this.logger.warn(
        'cloud-api: appSecret is not set — X-Hub-Signature-256 will NOT be verified; anyone who discovers the webhook URL can forge inbound events',
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
      this.logger.info('cloud-api: webhook server listening', {
        port: this.port,
        path: this.webhookPath,
      });
    }
    handlers.onReady?.({ selfId: this.phoneNumberId });
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
   * Mount into an existing Node http(s) server: handles GET hub.challenge
   * verification and POST event delivery. Returns true if the request was handled
   * (path matched). Reads the raw body itself UNLESS `rawBody` is provided — pass
   * `rawBody` when a framework body-parser already consumed the stream (Express:
   * mount `express.raw()` with a wildcard `type` option on the webhook path and
   * pass `req.body`). The HMAC signature check always runs over these exact raw bytes.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse, rawBody?: Buffer): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== this.webhookPath) return false;

    if (req.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      if (mode === 'subscribe' && token === this.verifyToken) {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end(url.searchParams.get('hub.challenge') ?? '');
        this.logger.info('cloud-api: webhook verification succeeded');
      } else {
        res.statusCode = 403;
        res.end('Forbidden');
        this.logger.warn('cloud-api: webhook verification rejected', { mode });
      }
      return true;
    }

    if (req.method === 'POST') {
      let raw: Buffer;
      try {
        raw = rawBody ?? (await readRawBody(req));
      } catch (err) {
        this.logger.warn('cloud-api: failed to read webhook body', { error: String(err) });
        res.statusCode = 400;
        res.end('Bad Request');
        return true;
      }
      if (this.appSecret) {
        const header = req.headers['x-hub-signature-256'];
        const signature = Array.isArray(header) ? header[0] : header;
        if (!verifySignature(this.appSecret, raw, signature)) {
          this.logger.warn('cloud-api: rejected webhook POST with missing or invalid X-Hub-Signature-256');
          res.statusCode = 401;
          res.end('Invalid signature');
          return true;
        }
      } else if (!this.warnedNoSecret) {
        this.warnedNoSecret = true;
        this.logger.warn(
          'cloud-api: appSecret is not set — processing webhook POST WITHOUT signature verification',
        );
      }
      // Acknowledge immediately (Meta retries slow webhooks), then process async.
      res.statusCode = 200;
      res.end();
      void this.processWebhook(raw);
      return true;
    }

    res.statusCode = 405;
    res.setHeader('allow', 'GET, POST');
    res.end('Method Not Allowed');
    return true;
  }

  /**
   * Fetch-style twin of {@link handleRequest}, for runtimes and frameworks that
   * speak WHATWG `Request`/`Response`: Bun, Deno, Cloudflare Workers, Hono,
   * Next.js route handlers, SvelteKit, Remix. Path routing is the host's job —
   * every request handed in is treated as the webhook (there is no
   * `webhookPath` check). GET answers the hub.challenge verification, POST
   * verifies `X-Hub-Signature-256` over the raw bytes (401 when it fails, a
   * one-time warning when no `appSecret` is set) and acknowledges with 200
   * before processing; anything else is 405. An unreadable or oversized body
   * is 400.
   */
  async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      if (mode === 'subscribe' && token === this.verifyToken) {
        this.logger.info('cloud-api: webhook verification succeeded');
        return new Response(url.searchParams.get('hub.challenge') ?? '', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      this.logger.warn('cloud-api: webhook verification rejected', { mode });
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method === 'POST') {
      let raw: Buffer;
      try {
        raw = Buffer.from(await request.arrayBuffer());
      } catch (err) {
        this.logger.warn('cloud-api: failed to read webhook body', { error: String(err) });
        return new Response('Bad Request', { status: 400 });
      }
      if (raw.length > DEFAULT_MAX_BODY_BYTES) {
        this.logger.warn('cloud-api: webhook body exceeded the size cap', { bytes: raw.length });
        return new Response('Bad Request', { status: 400 });
      }
      if (this.appSecret) {
        const signature = request.headers.get('x-hub-signature-256') ?? undefined;
        if (!verifySignature(this.appSecret, raw, signature)) {
          this.logger.warn('cloud-api: rejected webhook POST with missing or invalid X-Hub-Signature-256');
          return new Response('Invalid signature', { status: 401 });
        }
      } else if (!this.warnedNoSecret) {
        this.warnedNoSecret = true;
        this.logger.warn(
          'cloud-api: appSecret is not set — processing webhook POST WITHOUT signature verification',
        );
      }
      void this.processWebhook(raw);
      return new Response(null, { status: 200 });
    }

    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, POST' } });
  }

  /**
   * Send a message to `chatId` (a phone number) via the Graph API. Media given
   * as a Buffer or local file path is uploaded first — including when buttons
   * are present, where the media becomes the interactive message header
   * (except audio/sticker, which Cloud API cannot render as a header and are
   * dropped with a warning).
   */
  async send(chatId: string, content: OutboundContent): Promise<SendResult> {
    const payload = toPayload(content);
    let uploadedMediaId: string | undefined;
    const media = payload.media;
    const hasButtons = payload.buttons !== undefined && payload.buttons.length > 0;
    // audio/sticker media cannot be an interactive header, so buildSendBody
    // drops it when buttons are present — skip the pointless upload.
    const usesMedia =
      media !== undefined && !(hasButtons && (media.kind === 'audio' || media.kind === 'sticker'));
    if (usesMedia && (Buffer.isBuffer(media.data) || !isHttpUrl(media.data))) {
      uploadedMediaId = await this.uploadMedia(media);
    }
    const body = buildSendBody(chatId, payload, uploadedMediaId, this.logger);
    const json = await this.postMessages(body);
    const messages = (json as { messages?: Array<{ id?: string }> }).messages;
    return { id: messages?.[0]?.id };
  }

  /**
   * Typing indicator. Cloud API ties typing to marking a message read, so this
   * needs an inbound message id: the transport keeps the last inbound id per chat
   * and no-ops when none is known. `sendTyping(chatId, false)` is always a no-op —
   * Cloud API auto-clears the indicator. Best-effort: Graph API failures are
   * debug-logged, never thrown — a typing indicator must not kill an agent turn.
   */
  async sendTyping(chatId: string, on: boolean): Promise<void> {
    if (!on) return;
    const messageId = this.lastInboundId.get(chatId);
    if (!messageId) return;
    try {
      await this.postMessages({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      });
    } catch (err) {
      this.logger.debug('cloud-api: typing indicator failed', { chatId, error: String(err) });
    }
  }

  /** Mark an inbound message as read. */
  async markRead(_chatId: string, messageId: string): Promise<void> {
    await this.postMessages({ messaging_product: 'whatsapp', status: 'read', message_id: messageId });
  }

  // ---------------------------------------------------------------- internals

  private graphUrl(path: string): string {
    return `${this.baseUrl}/${this.graphApiVersion}/${path}`;
  }

  private authHeader(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}` };
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
      this.logger.error('cloud-api: error handling webhook request', { error: e.message });
      this.handlers?.onError?.(e);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  }

  /**
   * Parse + map a webhook body and deliver messages to onMessage, in order,
   * WITHOUT awaiting each handler: Bot's per-chat queue already preserves
   * per-chat order (its enqueue is synchronous), and awaiting here would let one
   * chat's slow agent turn block delivery to every other chat in the same POST.
   * Redelivered message ids (Meta is at-least-once) are skipped.
   */
  private async processWebhook(raw: Buffer): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logger.warn('cloud-api: ignoring webhook POST with invalid JSON body');
      return;
    }
    const messages = mapWebhookPayload(body, {
      downloadMedia: (mediaId) => this.downloadMedia(mediaId),
      logger: this.logger,
    });
    for (const msg of messages) {
      if (this.stopped || !this.handlers) return;
      if (this.seenMessageIds.has(msg.id)) {
        this.logger.debug('cloud-api: skipping redelivered message', { id: msg.id });
        continue;
      }
      this.rememberSeen(msg.id);
      this.rememberLastInbound(msg.chatId, msg.id);
      const handlers = this.handlers;
      void Promise.resolve()
        .then(() => handlers.onMessage(msg))
        .catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          if (handlers.onError) handlers.onError(e);
          else this.logger.error('cloud-api: onMessage handler failed', { error: e.message });
        });
    }
  }

  /** Record a delivered message id for redelivery dedup, evicting the oldest past the cap. */
  private rememberSeen(messageId: string): void {
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > TRACKING_CAP) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest !== undefined) this.seenMessageIds.delete(oldest);
    }
  }

  /** Record the last inbound id for a chat, evicting the least-recently-active chat past the cap. */
  private rememberLastInbound(chatId: string, messageId: string): void {
    this.lastInboundId.delete(chatId); // re-insert so active chats move to the back
    this.lastInboundId.set(chatId, messageId);
    if (this.lastInboundId.size > TRACKING_CAP) {
      const oldest = this.lastInboundId.keys().next().value;
      if (oldest !== undefined) this.lastInboundId.delete(oldest);
    }
  }

  /** Two-hop media download: GET /{media-id} for the URL, then GET it with the Bearer token. */
  private async downloadMedia(mediaId: string): Promise<Buffer> {
    const metaRes = await fetch(this.graphUrl(mediaId), { headers: this.authHeader() });
    const metaText = await metaRes.text();
    if (!metaRes.ok) {
      throw new Error(`Cloud API media lookup failed with status ${metaRes.status}: ${metaText}`);
    }
    let url: string | undefined;
    try {
      url = (JSON.parse(metaText) as { url?: string }).url;
    } catch {
      /* handled below */
    }
    if (!url) throw new Error(`Cloud API media lookup for ${mediaId} returned no download url`);
    const fileRes = await fetch(url, { headers: this.authHeader() });
    if (!fileRes.ok) {
      throw new Error(`Cloud API media download failed with status ${fileRes.status}: ${await fileRes.text()}`);
    }
    return Buffer.from(await fileRes.arrayBuffer());
  }

  /** Upload Buffer/local-path media via `/{phoneNumberId}/media`; returns the media id. */
  private async uploadMedia(media: OutboundMedia): Promise<string> {
    if (!media.mimetype) {
      throw new Error(
        'OutboundMedia.mimetype is required when sending media as a Buffer or local file path (the Cloud API upload needs a MIME type)',
      );
    }
    const bytes = Buffer.isBuffer(media.data) ? media.data : await readFile(media.data);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', media.mimetype);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: media.mimetype }), media.filename ?? 'file');
    const res = await fetch(this.graphUrl(`${this.phoneNumberId}/media`), {
      method: 'POST',
      headers: this.authHeader(),
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Cloud API media upload failed with status ${res.status}: ${text}`);
    }
    const id = (JSON.parse(text) as { id?: string }).id;
    if (!id) throw new Error(`Cloud API media upload returned no id: ${text}`);
    return id;
  }

  /** POST to `/{phoneNumberId}/messages`; non-2xx throws with status + response body. */
  private async postMessages(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.graphUrl(`${this.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { ...this.authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Cloud API request failed with status ${res.status}: ${text}`);
    }
    try {
      return text ? (JSON.parse(text) as unknown) : {};
    } catch {
      return {};
    }
  }
}
