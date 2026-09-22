/**
 * Integration tests: a real node:http webhook server (the transport's own, or a
 * hand-rolled one for the rawBody path) plus a local fake Twilio REST API used
 * as `apiBaseUrl`. Everything runs on ephemeral 127.0.0.1 ports — no network.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage, Logger } from '@wappajs/core';
import { TwilioTransport, type TwilioTransportOptions } from './transport.js';
import { computeTwilioSignature, readRawBody } from './webhook.js';

const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const AUTH_TOKEN = 'test-auth-token-1234567890abcdef';
const FROM_NUMBER = 'whatsapp:+14155238886';
const SENDER = 'whatsapp:+15551234567';
const SID = 'SM2f2a3c1e9b8d4a6f8c1e2d3b4a5f6e7d';
/** The public URL configured as webhookUrl in setup() — what Twilio "signed". */
const WEBHOOK_URL = 'https://bot.example.com/webhook';
const BASIC_AUTH = `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// ------------------------------------------------------------------ helpers

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface FakeTwilio {
  origin: string;
  requests: RecordedRequest[];
  /** Override the next responses of POST .../Messages.json. */
  setMessagesResponse(status: number, body: string): void;
}

/** Local stand-in for api.twilio.com: Messages.json + media download (with a redirect hop). */
async function startFakeTwilio(): Promise<FakeTwilio> {
  const requests: RecordedRequest[] = [];
  let messagesStatus = 201;
  let messagesBody = JSON.stringify({ sid: 'SM_SENT_1', status: 'queued', from: FROM_NUMBER });
  const server = createServer(async (req, res) => {
    const body = await readRawBody(req);
    const path = req.url ?? '/';
    requests.push({ method: req.method ?? '', path, headers: req.headers, body });
    if (req.method === 'POST' && path === `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`) {
      res.setHeader('content-type', 'application/json');
      res.statusCode = messagesStatus;
      res.end(messagesBody);
    } else if (req.method === 'GET' && path === '/media/ME123') {
      // Twilio media URLs redirect to a CDN — same-origin here, auth preserved.
      res.statusCode = 302;
      res.setHeader('location', '/cdn/ME123');
      res.end();
    } else if (req.method === 'GET' && path === '/cdn/ME123') {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('jpeg-bytes-123'));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 20404, message: `Unknown path ${path}` }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  );
  return {
    origin,
    requests,
    setMessagesResponse(status, body) {
      messagesStatus = status;
      messagesBody = body;
    },
  };
}

function spyLogger(): Logger & Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn>> {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface Setup {
  transport: TwilioTransport;
  twilio: FakeTwilio;
  messages: InboundMessage[];
  logger: ReturnType<typeof spyLogger>;
  webhookUrl: string;
}

/** Start a fake Twilio + a transport with its own webhook server on an ephemeral port. */
async function setup(overrides: Partial<TwilioTransportOptions> = {}): Promise<Setup> {
  const twilio = await startFakeTwilio();
  const messages: InboundMessage[] = [];
  const logger = spyLogger();
  const transport = new TwilioTransport({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    whatsappNumber: FROM_NUMBER,
    port: 0,
    webhookUrl: WEBHOOK_URL,
    apiBaseUrl: twilio.origin,
    logger,
    ...overrides,
  });
  await transport.start({
    onMessage: (m) => {
      messages.push(m);
    },
  });
  cleanups.push(() => transport.stop());
  const port = (transport.httpServer!.address() as AddressInfo).port;
  return { transport, twilio, messages, logger, webhookUrl: `http://127.0.0.1:${port}/webhook` };
}

/** Realistic inbound WhatsApp webhook params. */
function inboundParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SmsMessageSid: SID,
    NumMedia: '0',
    ProfileName: 'Kerry Fisher',
    MessageType: 'text',
    SmsSid: SID,
    WaId: '15551234567',
    SmsStatus: 'received',
    Body: 'hello there',
    To: FROM_NUMBER,
    NumSegments: '1',
    MessageSid: SID,
    AccountSid: ACCOUNT_SID,
    From: SENDER,
    ApiVersion: '2010-04-01',
    ...overrides,
  };
}

function textParams(text: string, id = SID): Record<string, string> {
  return inboundParams({ Body: text, MessageSid: id, SmsMessageSid: id, SmsSid: id });
}

/**
 * POST form-encoded webhook params, signed over `signUrl` (default: the
 * configured WEBHOOK_URL) unless `signature` overrides it (null = no header).
 */
async function postWebhook(
  url: string,
  params: Record<string, string>,
  opts: { signature?: string | null; signUrl?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const signature =
    opts.signature !== undefined
      ? opts.signature
      : computeTwilioSignature(AUTH_TOKEN, opts.signUrl ?? WEBHOOK_URL, params);
  if (signature !== null) headers['x-twilio-signature'] = signature;
  return fetch(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// -------------------------------------------------------------------- tests

describe('POST signature verification', () => {
  it('accepts a valid signature, answers 200 empty TwiML, and delivers the message', async () => {
    const { webhookUrl, messages } = await setup();
    const res = await postWebhook(webhookUrl, textParams('hello there'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/xml');
    expect(await res.text()).toBe('<Response/>');
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.text).toBe('hello there');
    expect(messages[0]!.chatId).toBe(SENDER); // verbatim whatsapp:+E164
  });

  it('rejects an invalid signature with 403 and processes nothing', async () => {
    const { webhookUrl, messages } = await setup();
    const forged = await postWebhook(webhookUrl, textParams('forged'), {
      signature: computeTwilioSignature('wrong-token', WEBHOOK_URL, textParams('forged')),
    });
    expect(forged.status).toBe(403);
    const garbage = await postWebhook(webhookUrl, textParams('forged 2'), { signature: 'AAAA' });
    expect(garbage.status).toBe(403);
    // A valid marker message proves the forged ones were never delivered.
    await postWebhook(webhookUrl, textParams('marker'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['marker']);
  });

  it('rejects a missing signature header with 403', async () => {
    const { webhookUrl, messages } = await setup();
    const res = await postWebhook(webhookUrl, textParams('unsigned'), { signature: null });
    expect(res.status).toBe(403);
    await postWebhook(webhookUrl, textParams('marker'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['marker']);
  });

  it('reconstructs the URL from the Host header when webhookUrl is unset, warning once', async () => {
    const { webhookUrl, messages, logger } = await setup({ webhookUrl: undefined });
    // Twilio signs the public URL; the reconstruction is 'https://' + Host + path.
    const signUrl = webhookUrl.replace('http://', 'https://');
    expect((await postWebhook(webhookUrl, textParams('one', 'SM_HOST_1'), { signUrl })).status).toBe(200);
    expect((await postWebhook(webhookUrl, textParams('two', 'SM_HOST_2'), { signUrl })).status).toBe(200);
    await waitFor(() => messages.length === 2);
    const warns = logger.warn.mock.calls.filter(([msg]) => /webhookUrl is not configured/.test(String(msg)));
    expect(warns).toHaveLength(1);
    // Signed for a different URL -> rejected.
    const bad = await postWebhook(webhookUrl, textParams('forged'), { signUrl: 'https://evil.example/webhook' });
    expect(bad.status).toBe(403);
  });

  it('treats an empty-string webhookUrl as unset (TWILIO_WEBHOOK_URL= via --env-file)', async () => {
    const { webhookUrl, messages } = await setup({ webhookUrl: '' });
    // Must fall back to Host-header reconstruction — NOT sign over the empty string.
    const signUrl = webhookUrl.replace('http://', 'https://');
    expect((await postWebhook(webhookUrl, textParams('still works'), { signUrl })).status).toBe(200);
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.text).toBe('still works');
  });

  it('skips validation entirely with validateSignature: false (warns at start)', async () => {
    const { webhookUrl, messages, logger } = await setup({ validateSignature: false });
    const res = await postWebhook(webhookUrl, textParams('trusting'), { signature: null });
    expect(res.status).toBe(200);
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.text).toBe('trusting');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/signature validation is DISABLED/));
  });

  it('404s outside the webhook path and 405s non-POST methods', async () => {
    const { webhookUrl } = await setup();
    expect((await fetch(webhookUrl.replace('/webhook', '/other'))).status).toBe(404);
    expect((await fetch(webhookUrl)).status).toBe(405);
  });
});

describe('webhook delivery semantics', () => {
  it('acknowledges and ignores status callbacks', async () => {
    const { webhookUrl, messages, logger } = await setup();
    const res = await postWebhook(webhookUrl, {
      MessageSid: 'SM_STATUS_1',
      MessageStatus: 'delivered',
      SmsStatus: 'delivered',
      To: SENDER,
      From: FROM_NUMBER,
      AccountSid: ACCOUNT_SID,
      ApiVersion: '2010-04-01',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<Response/>');
    await postWebhook(webhookUrl, textParams('marker'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['marker']);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/status callback/), expect.anything());
  });

  it('delivers a redelivered MessageSid only once (Twilio webhook retries)', async () => {
    const { webhookUrl, messages } = await setup();
    const params = textParams('pay the invoice', 'SM_DUP_1');
    await postWebhook(webhookUrl, params);
    await postWebhook(webhookUrl, params); // Twilio retry of the exact same payload
    await postWebhook(webhookUrl, textParams('marker', 'SM_MARKER_1'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['pay the invoice', 'marker']);
  });

  it('bounds the dedup set at 1000 sids, evicting in insertion order', async () => {
    const { transport, webhookUrl, messages } = await setup();
    const sids = Array.from({ length: 1005 }, (_, i) => `SM_BULK_${String(i).padStart(4, '0')}`);
    for (let i = 0; i < sids.length; i += 100) {
      await Promise.all(sids.slice(i, i + 100).map((sid, j) => postWebhook(webhookUrl, textParams(`m${i + j}`, sid))));
    }
    await waitFor(() => messages.length === 1005, 10_000);
    const seen = (transport as unknown as { seenMessageSids: Set<string> }).seenMessageSids;
    expect(seen.size).toBe(1000);
    // The oldest sid was evicted, so its redelivery is processed again...
    await postWebhook(webhookUrl, textParams('evicted redelivery', sids[0]!));
    await waitFor(() => messages.length === 1006);
    // ...while a still-tracked recent sid stays deduped.
    await postWebhook(webhookUrl, textParams('tracked redelivery', sids[1004]!));
    await postWebhook(webhookUrl, textParams('marker', 'SM_MARKER_2'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).not.toContain('tracked redelivery');
  }, 15_000);

  it('delivers a second chat while the first onMessage is still pending (no head-of-line blocking)', async () => {
    const twilio = await startFakeTwilio();
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transport = new TwilioTransport({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      whatsappNumber: FROM_NUMBER,
      port: 0,
      webhookUrl: WEBHOOK_URL,
      apiBaseUrl: twilio.origin,
      logger: spyLogger(),
    });
    await transport.start({
      onMessage: async (m) => {
        delivered.push(m.chatId);
        if (m.chatId === 'whatsapp:+1000') await firstBlocked; // this chat's agent turn hangs
      },
    });
    cleanups.push(() => transport.stop());
    const port = (transport.httpServer!.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/webhook`;
    await postWebhook(url, inboundParams({ From: 'whatsapp:+1000', Body: 'one', MessageSid: 'SM_HOL_1' }));
    await postWebhook(url, inboundParams({ From: 'whatsapp:+2000', Body: 'two', MessageSid: 'SM_HOL_2' }));
    // Chat +2000 must be delivered although chat +1000's promise never settled.
    await waitFor(() => delivered.length === 2);
    expect(delivered).toEqual(['whatsapp:+1000', 'whatsapp:+2000']);
    releaseFirst();
  });
});

describe('inbound mapping over the wire', () => {
  it('delivers a template button reply with buttonId', async () => {
    const { webhookUrl, messages } = await setup();
    await postWebhook(
      webhookUrl,
      inboundParams({ MessageType: 'button', Body: 'Track order', ButtonText: 'Track order', ButtonPayload: 'btn-track' }),
    );
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.text).toBe('Track order');
    expect(messages[0]!.buttonId).toBe('btn-track');
  });

  it('delivers media whose download() GETs the MediaUrl with basic auth, following the redirect', async () => {
    const { webhookUrl, messages, twilio } = await setup();
    await postWebhook(
      webhookUrl,
      inboundParams({
        MessageType: 'image',
        Body: 'look',
        NumMedia: '1',
        MediaUrl0: `${twilio.origin}/media/ME123`,
        MediaContentType0: 'image/jpeg',
      }),
    );
    await waitFor(() => messages.length === 1);
    const m = messages[0]!;
    expect(m.text).toBe('look');
    expect(m.media?.kind).toBe('image');
    expect(m.media?.mimetype).toBe('image/jpeg');
    // Lazy: nothing fetched yet.
    expect(twilio.requests).toHaveLength(0);
    const buf = await m.media!.download();
    expect(buf).toEqual(Buffer.from('jpeg-bytes-123'));
    const first = twilio.requests.find((r) => r.path === '/media/ME123');
    expect(first?.headers.authorization).toBe(BASIC_AUTH);
    expect(twilio.requests.some((r) => r.path === '/cdn/ME123')).toBe(true);
  });

  it('never sends the basic-auth header to a MediaUrl on a foreign origin', async () => {
    const { webhookUrl, messages } = await setup();
    const authHeaders: Array<string | undefined> = [];
    const foreign = createServer((req, res) => {
      authHeaders.push(req.headers.authorization);
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('foreign-bytes'));
    });
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          foreign.close(() => resolve());
          foreign.closeIdleConnections();
        }),
    );
    const origin = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`;
    await postWebhook(
      webhookUrl,
      inboundParams({
        MessageType: 'image',
        NumMedia: '1',
        MediaUrl0: `${origin}/media/X`,
        MediaContentType0: 'image/jpeg',
      }),
    );
    await waitFor(() => messages.length === 1);
    expect(await messages[0]!.media!.download()).toEqual(Buffer.from('foreign-bytes'));
    expect(authHeaders).toEqual([undefined]);
  });

  it('delivers location and reaction messages', async () => {
    const { webhookUrl, messages } = await setup();
    await postWebhook(
      webhookUrl,
      inboundParams({
        MessageType: 'location',
        Body: '',
        Latitude: '37.4847',
        Longitude: '-122.1477',
        Label: 'Meta HQ',
        Address: '1 Hacker Way',
        MessageSid: 'SM_LOC_1',
      }),
    );
    await postWebhook(
      webhookUrl,
      inboundParams({
        MessageType: 'reaction',
        Body: '❤️',
        OriginalRepliedMessageSid: 'SM_TARGET',
        MessageSid: 'SM_REACT_1',
      }),
    );
    await waitFor(() => messages.length === 2);
    expect(messages[0]!.location).toEqual({
      latitude: 37.4847,
      longitude: -122.1477,
      name: 'Meta HQ',
      address: '1 Hacker Way',
    });
    expect(messages[1]!.reaction).toEqual({ emoji: '❤️', targetMessageId: 'SM_TARGET' });
  });

  it('skips contentless payloads silently (debug log)', async () => {
    const { webhookUrl, messages, logger } = await setup();
    // No SmsStatus/MessageStatus — otherwise a contentless bag reads as a status callback.
    const contentless = inboundParams({ Body: '', MessageType: 'unknown' });
    delete contentless.SmsStatus;
    const res = await postWebhook(webhookUrl, contentless);
    expect(res.status).toBe(200);
    await postWebhook(webhookUrl, textParams('marker', 'SM_MARKER_3'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['marker']);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/contentless/), expect.anything());
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('send', () => {
  it('POSTs a form-encoded text message with basic auth and returns the sid', async () => {
    const { transport, twilio } = await setup();
    const result = await transport.send('+15551234567', 'hi there');
    expect(result).toEqual({ id: 'SM_SENT_1' });
    expect(twilio.requests).toHaveLength(1);
    const req = twilio.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe(`/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`);
    expect(req.headers.authorization).toBe(BASIC_AUTH);
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(req.body.toString()))).toEqual({
      From: 'whatsapp:+14155238886',
      To: 'whatsapp:+15551234567',
      Body: 'hi there',
    });
  });

  it('round-trips an inbound chatId verbatim as To', async () => {
    const { transport, twilio, webhookUrl, messages } = await setup();
    await postWebhook(webhookUrl, textParams('hello'));
    await waitFor(() => messages.length === 1);
    await transport.send(messages[0]!.chatId, 'and hello to you');
    const body = new URLSearchParams(twilio.requests[0]!.body.toString());
    expect(body.get('To')).toBe(SENDER);
  });

  it('sends URL media as MediaUrl', async () => {
    const { transport, twilio } = await setup();
    await transport.send(SENDER, {
      media: { kind: 'image', data: 'https://example.com/cat.jpg', caption: 'a cat' },
    });
    const body = new URLSearchParams(twilio.requests[0]!.body.toString());
    expect(body.get('MediaUrl')).toBe('https://example.com/cat.jpg');
    expect(body.get('Body')).toBe('a cat');
  });

  it('throws for Buffer media without making a request (public URL required)', async () => {
    const { transport, twilio } = await setup();
    await expect(
      transport.send(SENDER, { media: { kind: 'image', data: Buffer.from('png-bytes'), mimetype: 'image/png' } }),
    ).rejects.toThrow(/public http\(s\) URL/);
    expect(twilio.requests).toHaveLength(0);
  });

  it('sends a location as PersistentAction', async () => {
    const { transport, twilio } = await setup();
    await transport.send(SENDER, { location: { latitude: 37.4847, longitude: -122.1477, name: 'Meta HQ' } });
    const body = new URLSearchParams(twilio.requests[0]!.body.toString());
    expect(body.getAll('PersistentAction')).toEqual(['geo:37.4847,-122.1477|Meta HQ']);
  });

  it('renders buttons as the numbered text fallback', async () => {
    const { transport, twilio } = await setup();
    await transport.send(SENDER, {
      text: 'Pick one',
      buttons: [
        { id: 'a', title: 'Alpha' },
        { id: 'b', title: 'Beta' },
      ],
    });
    const body = new URLSearchParams(twilio.requests[0]!.body.toString());
    expect(body.get('Body')).toBe('Pick one\n\n1. Alpha\n2. Beta');
  });

  it('throws on non-2xx including status and response body', async () => {
    const { transport, twilio } = await setup();
    twilio.setMessagesResponse(
      400,
      JSON.stringify({ code: 63007, message: 'Twilio could not find a Channel with the specified From address' }),
    );
    await expect(transport.send(SENDER, 'nope')).rejects.toThrow(/status 400.*63007/s);
  });
});

describe('capability surface', () => {
  it('omits sendTyping and markRead entirely (Bot feature-detects via "in")', async () => {
    const { transport } = await setup();
    expect('sendTyping' in transport).toBe(false);
    expect('markRead' in transport).toBe(false);
  });
});

describe('handleRequest with rawBody (framework body-parser path)', () => {
  /** Express-style host: consumes the stream itself, then hands the raw bytes over. */
  async function startHost(transport: TwilioTransport): Promise<string> {
    const server: Server = createServer(async (req, res) => {
      const raw = await readRawBody(req); // body-parser already drained the stream
      const handled = await transport.handleRequest(req, res, raw);
      if (!handled) {
        res.statusCode = 404;
        res.end('no route');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        }),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
  }

  it('verifies the signature over the provided rawBody and delivers messages', async () => {
    const twilio = await startFakeTwilio();
    const messages: InboundMessage[] = [];
    const transport = new TwilioTransport({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      whatsappNumber: FROM_NUMBER,
      webhookUrl: WEBHOOK_URL,
      apiBaseUrl: twilio.origin,
      logger: spyLogger(),
    });
    await transport.start({ onMessage: (m) => void messages.push(m) });
    cleanups.push(() => transport.stop());
    expect(transport.httpServer).toBeUndefined(); // no port -> no internal server

    const url = await startHost(transport);
    const ok = await postWebhook(url, textParams('via express'));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('<Response/>');
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.text).toBe('via express');

    const bad = await postWebhook(url, textParams('forged'), {
      signature: computeTwilioSignature('wrong-token', WEBHOOK_URL, textParams('forged')),
    });
    expect(bad.status).toBe(403);

    // Unmatched path: handleRequest returns false and the host answers itself.
    const miss = await fetch(url.replace('/webhook', '/health'));
    expect(miss.status).toBe(404);
    expect(await miss.text()).toBe('no route');
  });
});

describe('lifecycle', () => {
  it('start fires onReady with the whatsapp:-prefixed sender and stop is idempotent', async () => {
    const twilio = await startFakeTwilio();
    const ready = vi.fn();
    const transport = new TwilioTransport({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      whatsappNumber: '+14155238886', // bare — must be normalized
      port: 0,
      webhookUrl: WEBHOOK_URL,
      apiBaseUrl: twilio.origin,
      logger: spyLogger(),
    });
    await transport.start({ onMessage: () => undefined, onReady: ready });
    expect(ready).toHaveBeenCalledWith({ selfId: 'whatsapp:+14155238886' });
    await transport.stop();
    await transport.stop();
    expect(transport.httpServer).toBeUndefined();
  });

  it('constructor rejects missing required options', () => {
    const base = { accountSid: 'AC', authToken: 'T', whatsappNumber: '+1' };
    expect(() => new TwilioTransport({ ...base, accountSid: '' })).toThrow(/accountSid/);
    expect(() => new TwilioTransport({ ...base, authToken: '' })).toThrow(/authToken/);
    expect(() => new TwilioTransport({ ...base, whatsappNumber: '' })).toThrow(/whatsappNumber/);
  });

  it('exposes name "twilio"', async () => {
    const { transport } = await setup();
    expect(transport.name).toBe('twilio');
  });
});

describe('handleFetch (Bun, Deno, Workers, Hono, Next.js route handlers)', () => {
  /** A transport with no server of its own, as a fetch-style host would mount it. */
  async function fetchSetup(overrides: Partial<TwilioTransportOptions> = {}) {
    const twilio = await startFakeTwilio();
    const messages: InboundMessage[] = [];
    const logger = spyLogger();
    const transport = new TwilioTransport({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      whatsappNumber: FROM_NUMBER,
      webhookUrl: WEBHOOK_URL,
      apiBaseUrl: twilio.origin,
      logger,
      ...overrides,
    });
    await transport.start({
      onMessage: (m) => {
        messages.push(m);
      },
    });
    cleanups.push(() => transport.stop());
    return { transport, twilio, messages, logger };
  }

  /** A WHATWG Request as a fetch host would hand it over, signed like Twilio signs. */
  function webhookRequest(
    params: Record<string, string>,
    opts: { signature?: string | null; signUrl?: string; url?: string; method?: string; body?: string } = {},
  ): Request {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const signature =
      opts.signature !== undefined
        ? opts.signature
        : computeTwilioSignature(AUTH_TOKEN, opts.signUrl ?? WEBHOOK_URL, params);
    if (signature !== null) headers['x-twilio-signature'] = signature;
    return new Request(opts.url ?? 'http://localhost:3000/api/whatsapp/twilio', {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body ?? new URLSearchParams(params).toString(),
    });
  }

  it('answers 200 + empty TwiML for a valid signature and delivers the message', async () => {
    const s = await fetchSetup();
    const res = await s.transport.handleFetch(webhookRequest(textParams('hi from bun')));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/xml');
    expect(await res.text()).toBe('<Response/>');
    await waitFor(() => s.messages.length === 1);
    expect(s.messages[0]).toMatchObject({ id: SID, chatId: SENDER, senderId: SENDER, text: 'hi from bun' });
  });

  it('rejects a bad signature and a missing header with 403 and delivers nothing', async () => {
    const s = await fetchSetup();
    const bad = await s.transport.handleFetch(webhookRequest(textParams('x'), { signature: 'nope' }));
    const none = await s.transport.handleFetch(webhookRequest(textParams('x'), { signature: null }));
    expect(bad.status).toBe(403);
    expect(none.status).toBe(403);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.messages).toHaveLength(0);
    expect(s.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('ignores the request path: whatever the host routed here is the webhook', async () => {
    const s = await fetchSetup();
    const res = await s.transport.handleFetch(
      webhookRequest(textParams('any path'), { url: 'http://localhost/some/other/route' }),
    );
    expect(res.status).toBe(200);
    await waitFor(() => s.messages.length === 1);
  });

  it('answers 405 for anything but POST', async () => {
    const s = await fetchSetup();
    const res = await s.transport.handleFetch(
      new Request('http://localhost/api/whatsapp/twilio', { method: 'GET' }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('reconstructs the signed URL from the request when webhookUrl is unset, warning once', async () => {
    const s = await fetchSetup({ webhookUrl: undefined });
    const url = 'https://bot.example.com/hooks/twilio?tenant=1';
    const first = await s.transport.handleFetch(webhookRequest(textParams('a'), { signUrl: url, url }));
    const second = await s.transport.handleFetch(
      webhookRequest(textParams('b', 'SM_second'), { signUrl: url, url }),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await waitFor(() => s.messages.length === 2);
    expect(s.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('acknowledges and ignores a status callback', async () => {
    const s = await fetchSetup();
    const params = {
      MessageSid: 'SM_status',
      SmsSid: 'SM_status',
      AccountSid: ACCOUNT_SID,
      From: FROM_NUMBER,
      To: SENDER,
      MessageStatus: 'delivered',
      SmsStatus: 'delivered',
      ApiVersion: '2010-04-01',
    };
    const res = await s.transport.handleFetch(webhookRequest(params));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.messages).toHaveLength(0);
  });

  it('answers 400 for a body over the 1 MiB cap without checking the signature', async () => {
    const s = await fetchSetup();
    const res = await s.transport.handleFetch(
      webhookRequest(textParams('big'), { body: 'a'.repeat(1024 * 1024 + 1) }),
    );
    expect(res.status).toBe(400);
    expect(s.messages).toHaveLength(0);
  });
});
