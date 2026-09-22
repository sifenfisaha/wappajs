/**
 * Integration tests: a real node:http webhook server (the transport's own, or a
 * hand-rolled one for the rawBody path) plus a local fake Graph API server used
 * as `baseUrl`. Everything runs on ephemeral 127.0.0.1 ports — no network.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage, Logger } from '@wappajs/core';
import { CloudApiTransport, type CloudApiTransportOptions } from './transport.js';
import { computeSignature, readRawBody } from './webhook.js';

const SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'my-verify-token';
const WAMID = 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTdCNEU1RDlEMjA3NUFCMkYzRQA=';

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

interface FakeGraph {
  origin: string;
  requests: RecordedRequest[];
  /** Override the next responses of POST /{phone}/messages. */
  setMessagesResponse(status: number, body: string): void;
}

/** Local stand-in for graph.facebook.com: /messages, /media upload, media download. */
async function startFakeGraph(): Promise<FakeGraph> {
  const requests: RecordedRequest[] = [];
  let messagesStatus = 200;
  let messagesBody = JSON.stringify({
    messaging_product: 'whatsapp',
    contacts: [{ input: '15551234567', wa_id: '15551234567' }],
    messages: [{ id: 'wamid.SENT_1' }],
  });
  let origin = '';
  const server = createServer(async (req, res) => {
    const body = await readRawBody(req);
    const path = req.url ?? '/';
    requests.push({ method: req.method ?? '', path, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && path === '/v23.0/PHONE_ID/messages') {
      res.statusCode = messagesStatus;
      res.end(messagesBody);
    } else if (req.method === 'POST' && path === '/v23.0/PHONE_ID/media') {
      res.end(JSON.stringify({ id: 'UPLOADED_MEDIA_ID' }));
    } else if (req.method === 'GET' && path === '/v23.0/MEDIA_ID_123') {
      res.end(
        JSON.stringify({
          url: `${origin}/cdn/MEDIA_ID_123`,
          mime_type: 'image/jpeg',
          sha256: 'sGmLxCarLLL9SmhBBRWJBjIfsQrDYcTGBFwCjyxJUFI=',
          file_size: 14,
          id: 'MEDIA_ID_123',
          messaging_product: 'whatsapp',
        }),
      );
    } else if (req.method === 'GET' && path === '/cdn/MEDIA_ID_123') {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('jpeg-bytes-123'));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `Unknown path ${path}` } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  transport: CloudApiTransport;
  graph: FakeGraph;
  messages: InboundMessage[];
  logger: ReturnType<typeof spyLogger>;
  webhookUrl: string;
}

/** Start a fake Graph + a transport with its own webhook server on an ephemeral port. */
async function setup(overrides: Partial<CloudApiTransportOptions> = {}): Promise<Setup> {
  const graph = await startFakeGraph();
  const messages: InboundMessage[] = [];
  const logger = spyLogger();
  const transport = new CloudApiTransport({
    accessToken: 'TEST_TOKEN',
    phoneNumberId: 'PHONE_ID',
    verifyToken: VERIFY_TOKEN,
    appSecret: SECRET,
    port: 0,
    baseUrl: graph.origin,
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
  return { transport, graph, messages, logger, webhookUrl: `http://127.0.0.1:${port}/webhook` };
}

/** Realistic v23.0 webhook body carrying one message (or an arbitrary value patch). */
function webhookBody(msg: Record<string, unknown> | null, value: Record<string, unknown> = {}): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: 'PHONE_ID' },
              ...(msg
                ? { contacts: [{ profile: { name: 'Kerry Fisher' }, wa_id: '15551234567' }], messages: [msg] }
                : {}),
              ...value,
            },
          },
        ],
      },
    ],
  });
}

function textBody(text: string, id = WAMID): string {
  return webhookBody({ from: '15551234567', id, timestamp: '1756000000', type: 'text', text: { body: text } });
}

/** POST a webhook body, signing it with `secret` unless null. */
async function postWebhook(url: string, body: string, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-hub-signature-256'] = computeSignature(secret, Buffer.from(body));
  return fetch(url, { method: 'POST', headers, body });
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// -------------------------------------------------------------------- tests

describe('GET webhook verification', () => {
  it('answers 200 + hub.challenge for the correct verify token', async () => {
    const { webhookUrl } = await setup();
    const res = await fetch(
      `${webhookUrl}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1158201444');
  });

  it('answers 403 for a wrong verify token', async () => {
    const { webhookUrl } = await setup();
    const res = await fetch(`${webhookUrl}?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=42`);
    expect(res.status).toBe(403);
  });

  it('answers 403 for a wrong hub.mode', async () => {
    const { webhookUrl } = await setup();
    const res = await fetch(`${webhookUrl}?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`);
    expect(res.status).toBe(403);
  });

  it('404s outside the webhook path and 405s unsupported methods', async () => {
    const { webhookUrl } = await setup();
    expect((await fetch(webhookUrl.replace('/webhook', '/other'))).status).toBe(404);
    expect((await fetch(webhookUrl, { method: 'PUT', body: '{}' })).status).toBe(405);
  });
});

describe('POST signature verification (appSecret set)', () => {
  it('accepts a valid signature and delivers the message', async () => {
    const { webhookUrl, messages } = await setup();
    const res = await postWebhook(webhookUrl, textBody('hello there'));
    expect(res.status).toBe(200);
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.text).toBe('hello there');
    expect(messages[0]!.chatId).toBe('15551234567');
  });

  it('rejects an invalid signature with 401 and processes nothing', async () => {
    const { webhookUrl, messages } = await setup();
    const forged = await postWebhook(webhookUrl, textBody('forged'), 'wrong-secret');
    expect(forged.status).toBe(401);
    const garbage = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      body: textBody('forged 2'),
    });
    expect(garbage.status).toBe(401);
    // A valid marker message proves the forged ones were never delivered.
    await postWebhook(webhookUrl, textBody('marker'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['marker']);
  });

  it('rejects a missing signature header with 401', async () => {
    const { webhookUrl, messages } = await setup();
    const res = await postWebhook(webhookUrl, textBody('unsigned'), null);
    expect(res.status).toBe(401);
    await postWebhook(webhookUrl, textBody('marker'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['marker']);
  });
});

describe('POST without appSecret configured', () => {
  it('processes unsigned events anyway and logs a warning', async () => {
    const { webhookUrl, messages, logger } = await setup({ appSecret: undefined });
    const res = await postWebhook(webhookUrl, textBody('trusting'), null);
    expect(res.status).toBe(200);
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.text).toBe('trusting');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/appSecret/));
  });
});

describe('inbound mapping over the wire', () => {
  it('delivers button_reply with text = title and buttonId = id', async () => {
    const { webhookUrl, messages } = await setup();
    await postWebhook(
      webhookUrl,
      webhookBody({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000001',
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'btn-track', title: 'Track order' } },
      }),
    );
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.text).toBe('Track order');
    expect(messages[0]!.buttonId).toBe('btn-track');
  });

  it('delivers an image whose download() runs the two-hop fetch against Graph', async () => {
    const { webhookUrl, messages, graph } = await setup();
    await postWebhook(
      webhookUrl,
      webhookBody({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000002',
        type: 'image',
        image: { id: 'MEDIA_ID_123', mime_type: 'image/jpeg', caption: 'look' },
      }),
    );
    await waitFor(() => messages.length === 1);
    const m = messages[0]!;
    expect(m.text).toBe('look');
    expect(m.media?.kind).toBe('image');
    expect(m.media?.mimetype).toBe('image/jpeg');
    // Lazy: nothing fetched yet.
    expect(graph.requests).toHaveLength(0);
    const buf = await m.media!.download();
    expect(buf).toEqual(Buffer.from('jpeg-bytes-123'));
    const meta = graph.requests.find((r) => r.path === '/v23.0/MEDIA_ID_123');
    const cdn = graph.requests.find((r) => r.path === '/cdn/MEDIA_ID_123');
    expect(meta?.headers.authorization).toBe('Bearer TEST_TOKEN');
    expect(cdn?.headers.authorization).toBe('Bearer TEST_TOKEN');
  });

  it('delivers a location message', async () => {
    const { webhookUrl, messages } = await setup();
    await postWebhook(
      webhookUrl,
      webhookBody({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000003',
        type: 'location',
        location: { latitude: 37.4847, longitude: -122.1477, name: 'Meta HQ', address: '1 Hacker Way' },
      }),
    );
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.location).toEqual({
      latitude: 37.4847,
      longitude: -122.1477,
      name: 'Meta HQ',
      address: '1 Hacker Way',
    });
  });

  it('ignores statuses events', async () => {
    const { webhookUrl, messages } = await setup();
    const res = await postWebhook(
      webhookUrl,
      webhookBody(null, {
        statuses: [{ id: WAMID, status: 'delivered', timestamp: '1756000004', recipient_id: '15551234567' }],
      }),
    );
    expect(res.status).toBe(200);
    await postWebhook(webhookUrl, textBody('marker'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['marker']);
  });

  it('skips unmapped message types silently', async () => {
    const { webhookUrl, messages, logger } = await setup();
    const res = await postWebhook(
      webhookUrl,
      webhookBody({ from: '15551234567', id: WAMID, timestamp: '1756000005', type: 'order', order: {} }),
    );
    expect(res.status).toBe(200);
    await postWebhook(webhookUrl, textBody('marker'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['marker']);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/unmapped/), expect.anything());
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('webhook delivery semantics', () => {
  /** Body with several text messages in one change (no contacts — not needed). */
  function multiMessageBody(msgs: Array<Record<string, unknown>>): string {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001111', phone_number_id: 'PHONE_ID' },
                messages: msgs,
              },
            },
          ],
        },
      ],
    });
  }

  function textMsg(from: string, id: string, body: string): Record<string, unknown> {
    return { from, id, timestamp: '1756000000', type: 'text', text: { body } };
  }

  it('delivers a second chat while the first onMessage is still pending (no head-of-line blocking)', async () => {
    const graph = await startFakeGraph();
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transport = new CloudApiTransport({
      accessToken: 'TEST_TOKEN',
      phoneNumberId: 'PHONE_ID',
      verifyToken: VERIFY_TOKEN,
      appSecret: SECRET,
      port: 0,
      baseUrl: graph.origin,
      logger: spyLogger(),
    });
    await transport.start({
      onMessage: async (m) => {
        delivered.push(m.chatId);
        if (m.chatId === '1000') await firstBlocked; // chat 1000's agent turn hangs
      },
    });
    cleanups.push(() => transport.stop());
    const port = (transport.httpServer!.address() as AddressInfo).port;
    await postWebhook(
      `http://127.0.0.1:${port}/webhook`,
      multiMessageBody([textMsg('1000', 'wamid.HOL_1', 'one'), textMsg('2000', 'wamid.HOL_2', 'two')]),
    );
    // Chat 2000 must be delivered although chat 1000's promise never settled.
    await waitFor(() => delivered.length === 2);
    expect(delivered).toEqual(['1000', '2000']);
    releaseFirst();
  });

  it('delivers a redelivered wamid only once (Meta at-least-once retries)', async () => {
    const { webhookUrl, messages } = await setup();
    const body = textBody('pay the invoice', 'wamid.DUP_1');
    await postWebhook(webhookUrl, body);
    await postWebhook(webhookUrl, body); // Meta redelivery of the exact same payload
    await postWebhook(webhookUrl, textBody('marker', 'wamid.MARKER_1'));
    await waitFor(() => messages.some((m) => m.text === 'marker'));
    expect(messages.map((m) => m.text)).toEqual(['pay the invoice', 'marker']);
  });

  it('caps the lastInboundId map at 1000 chats, evicting the oldest', async () => {
    const { transport, graph, webhookUrl, messages } = await setup();
    const senders = Array.from({ length: 1005 }, (_, i) => `1${String(i).padStart(10, '0')}`);
    await postWebhook(
      webhookUrl,
      multiMessageBody(senders.map((from, i) => textMsg(from, `wamid.BULK_${i}`, `m${i}`))),
    );
    await waitFor(() => messages.length === 1005);
    const map = (transport as unknown as { lastInboundId: Map<string, string> }).lastInboundId;
    expect(map.size).toBe(1000);
    // Evicted oldest sender: typing is a no-op; newest sender still works.
    await transport.sendTyping(senders[0]!, true);
    expect(graph.requests).toHaveLength(0);
    await transport.sendTyping(senders[1004]!, true);
    expect(graph.requests).toHaveLength(1);
  });
});

describe('send', () => {
  it('POSTs a text message and returns the wamid', async () => {
    const { transport, graph } = await setup();
    const result = await transport.send('15551234567', 'hi there');
    expect(result).toEqual({ id: 'wamid.SENT_1' });
    expect(graph.requests).toHaveLength(1);
    const req = graph.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v23.0/PHONE_ID/messages');
    expect(req.headers.authorization).toBe('Bearer TEST_TOKEN');
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body.toString())).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'text',
      text: { body: 'hi there', preview_url: true },
    });
  });

  it('POSTs native interactive buttons', async () => {
    const { transport, graph } = await setup();
    await transport.send('15551234567', {
      text: 'Pick one',
      buttons: [
        { id: 'a', title: 'Alpha' },
        { id: 'b', title: 'Beta' },
      ],
    });
    const body = JSON.parse(graph.requests[0]!.body.toString());
    expect(body.type).toBe('interactive');
    expect(body.interactive.type).toBe('button');
    expect(body.interactive.body).toEqual({ text: 'Pick one' });
    expect(body.interactive.action.buttons).toEqual([
      { type: 'reply', reply: { id: 'a', title: 'Alpha' } },
      { type: 'reply', reply: { id: 'b', title: 'Beta' } },
    ]);
  });

  it('throws for more than 3 buttons without making a request', async () => {
    const { transport, graph } = await setup();
    await expect(
      transport.send('15551234567', {
        text: 'too many',
        buttons: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
          { id: 'c', title: 'C' },
          { id: 'd', title: 'D' },
        ],
      }),
    ).rejects.toThrow(/at most 3/);
    expect(graph.requests).toHaveLength(0);
  });

  it('sends https media by link without uploading', async () => {
    const { transport, graph } = await setup();
    await transport.send('15551234567', {
      media: { kind: 'image', data: 'https://example.com/cat.jpg', caption: 'a cat' },
    });
    expect(graph.requests).toHaveLength(1);
    const body = JSON.parse(graph.requests[0]!.body.toString());
    expect(body.type).toBe('image');
    expect(body.image).toEqual({ link: 'https://example.com/cat.jpg', caption: 'a cat' });
  });

  it('uploads Buffer media via /media (multipart) then sends by id', async () => {
    const { transport, graph } = await setup();
    await transport.send('15551234567', {
      media: { kind: 'image', data: Buffer.from('png-bytes'), mimetype: 'image/png', filename: 'cat.png' },
    });
    expect(graph.requests.map((r) => r.path)).toEqual(['/v23.0/PHONE_ID/media', '/v23.0/PHONE_ID/messages']);
    const upload = graph.requests[0]!;
    expect(upload.headers.authorization).toBe('Bearer TEST_TOKEN');
    expect(String(upload.headers['content-type'])).toMatch(/^multipart\/form-data/);
    const uploadText = upload.body.toString('latin1');
    expect(uploadText).toContain('name="messaging_product"');
    expect(uploadText).toContain('whatsapp');
    expect(uploadText).toContain('filename="cat.png"');
    expect(uploadText).toContain('png-bytes');
    const sendBody = JSON.parse(graph.requests[1]!.body.toString());
    expect(sendBody.type).toBe('image');
    expect(sendBody.image).toEqual({ id: 'UPLOADED_MEDIA_ID' });
  });

  it('uploads Buffer media and attaches it as the interactive header when buttons are present', async () => {
    const { transport, graph } = await setup();
    await transport.send('15551234567', {
      text: 'Pick one',
      buttons: [{ id: 'a', title: 'Alpha' }],
      media: { kind: 'image', data: Buffer.from('png-bytes'), mimetype: 'image/png' },
    });
    expect(graph.requests.map((r) => r.path)).toEqual(['/v23.0/PHONE_ID/media', '/v23.0/PHONE_ID/messages']);
    const body = JSON.parse(graph.requests[1]!.body.toString());
    expect(body.type).toBe('interactive');
    expect(body.interactive.header).toEqual({ type: 'image', image: { id: 'UPLOADED_MEDIA_ID' } });
    expect(body.interactive.body).toEqual({ text: 'Pick one' });
  });

  it('adds context.message_id for replyTo', async () => {
    const { transport, graph } = await setup();
    await transport.send('15551234567', { text: 'reply', replyTo: 'wamid.ORIGINAL' });
    const body = JSON.parse(graph.requests[0]!.body.toString());
    expect(body.context).toEqual({ message_id: 'wamid.ORIGINAL' });
  });

  it('throws on non-2xx including status and response body', async () => {
    const { transport, graph } = await setup();
    graph.setMessagesResponse(
      400,
      JSON.stringify({
        error: {
          message: '(#131030) Recipient phone number not in allowed list',
          type: 'OAuthException',
          code: 131030,
          fbtrace_id: 'AbCdEf',
        },
      }),
    );
    await expect(transport.send('15551234567', 'nope')).rejects.toThrow(/status 400.*131030/s);
  });
});

describe('typing indicator and read receipts', () => {
  it('sendTyping(true) marks the last inbound message read with a typing_indicator', async () => {
    const { transport, graph, webhookUrl, messages } = await setup();
    await postWebhook(webhookUrl, textBody('hello', 'wamid.INBOUND_1'));
    await waitFor(() => messages.length === 1);
    await transport.sendTyping('15551234567', true);
    const body = JSON.parse(graph.requests.at(-1)!.body.toString());
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.INBOUND_1',
      typing_indicator: { type: 'text' },
    });
  });

  it('sendTyping resolves (best-effort, debug log) when the Graph API fails', async () => {
    const { transport, graph, webhookUrl, messages, logger } = await setup();
    await postWebhook(webhookUrl, textBody('hello', 'wamid.INBOUND_2'));
    await waitFor(() => messages.length === 1);
    graph.setMessagesResponse(500, JSON.stringify({ error: { message: 'server exploded' } }));
    await expect(transport.sendTyping('15551234567', true)).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/typing/), expect.anything());
  });

  it('sendTyping is a no-op with no known inbound id, and always for off', async () => {
    const { transport, graph } = await setup();
    await transport.sendTyping('15551234567', true);
    await transport.sendTyping('15551234567', false);
    expect(graph.requests).toHaveLength(0);
  });

  it('markRead posts a read status for the given message id', async () => {
    const { transport, graph } = await setup();
    await transport.markRead('15551234567', 'wamid.SEEN');
    const body = JSON.parse(graph.requests[0]!.body.toString());
    expect(body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.SEEN' });
  });
});

describe('handleRequest with rawBody (framework body-parser path)', () => {
  /** Express-style host: consumes the stream itself, then hands the raw bytes over. */
  async function startHost(transport: CloudApiTransport): Promise<string> {
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
    const graph = await startFakeGraph();
    const messages: InboundMessage[] = [];
    const transport = new CloudApiTransport({
      accessToken: 'TEST_TOKEN',
      phoneNumberId: 'PHONE_ID',
      verifyToken: VERIFY_TOKEN,
      appSecret: SECRET,
      baseUrl: graph.origin,
      logger: spyLogger(),
    });
    await transport.start({ onMessage: (m) => void messages.push(m) });
    cleanups.push(() => transport.stop());
    expect(transport.httpServer).toBeUndefined(); // no port -> no internal server

    const url = await startHost(transport);
    const ok = await postWebhook(url, textBody('via express'));
    expect(ok.status).toBe(200);
    await waitFor(() => messages.length === 1);
    expect(messages[0]!.text).toBe('via express');

    const bad = await postWebhook(url, textBody('forged'), 'wrong-secret');
    expect(bad.status).toBe(401);

    // GET verification also flows through handleRequest on the host server.
    const challenge = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=99`);
    expect(await challenge.text()).toBe('99');

    // Unmatched path: handleRequest returns false and the host answers itself.
    const miss = await fetch(url.replace('/webhook', '/health'));
    expect(miss.status).toBe(404);
    expect(await miss.text()).toBe('no route');
  });
});

describe('lifecycle', () => {
  it('start fires onReady with selfId = phoneNumberId and stop is idempotent', async () => {
    const graph = await startFakeGraph();
    const ready = vi.fn();
    const transport = new CloudApiTransport({
      accessToken: 'TEST_TOKEN',
      phoneNumberId: 'PHONE_ID',
      verifyToken: VERIFY_TOKEN,
      appSecret: SECRET,
      port: 0,
      baseUrl: graph.origin,
      logger: spyLogger(),
    });
    await transport.start({ onMessage: () => undefined, onReady: ready });
    expect(ready).toHaveBeenCalledWith({ selfId: 'PHONE_ID' });
    await transport.stop();
    await transport.stop();
    expect(transport.httpServer).toBeUndefined();
  });

  it('constructor rejects missing required options', () => {
    const base = { accessToken: 'T', phoneNumberId: 'P', verifyToken: 'V' };
    expect(() => new CloudApiTransport({ ...base, accessToken: '' })).toThrow(/accessToken/);
    expect(() => new CloudApiTransport({ ...base, phoneNumberId: '' })).toThrow(/phoneNumberId/);
    expect(() => new CloudApiTransport({ ...base, verifyToken: '' })).toThrow(/verifyToken/);
  });

  it('exposes name "cloud-api"', async () => {
    const { transport } = await setup();
    expect(transport.name).toBe('cloud-api');
  });
});

describe('handleFetch (Bun, Deno, Workers, Hono, Next.js route handlers)', () => {
  /** A transport with no server of its own, as a fetch-style host would mount it. */
  async function fetchSetup(overrides: Partial<CloudApiTransportOptions> = {}) {
    const graph = await startFakeGraph();
    const messages: InboundMessage[] = [];
    const logger = spyLogger();
    const transport = new CloudApiTransport({
      accessToken: 'TEST_TOKEN',
      phoneNumberId: 'PHONE_ID',
      verifyToken: VERIFY_TOKEN,
      appSecret: SECRET,
      baseUrl: graph.origin,
      logger,
      ...overrides,
    });
    await transport.start({
      onMessage: (m) => {
        messages.push(m);
      },
    });
    cleanups.push(() => transport.stop());
    return { transport, graph, messages, logger };
  }

  const BASE = 'http://localhost:3000/api/whatsapp/meta';

  /** A WHATWG POST as a fetch host would hand it over, signed with `secret` unless null. */
  function postRequest(body: string, secret: string | null = SECRET): Request {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret !== null) headers['x-hub-signature-256'] = computeSignature(secret, Buffer.from(body));
    return new Request(BASE, { method: 'POST', headers, body });
  }

  it('answers the GET verification handshake', async () => {
    const s = await fetchSetup();
    const ok = await s.transport.handleFetch(
      new Request(`${BASE}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('12345');

    const wrong = await s.transport.handleFetch(
      new Request(`${BASE}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`),
    );
    expect(wrong.status).toBe(403);
  });

  it('accepts a signed POST with 200 and delivers the message', async () => {
    const s = await fetchSetup();
    const res = await s.transport.handleFetch(postRequest(textBody('hi from bun')));
    expect(res.status).toBe(200);
    await waitFor(() => s.messages.length === 1);
    expect(s.messages[0]).toMatchObject({ id: WAMID, chatId: '15551234567', text: 'hi from bun' });
  });

  it('rejects a bad or missing signature with 401 and delivers nothing', async () => {
    const s = await fetchSetup();
    expect((await s.transport.handleFetch(postRequest(textBody('x'), 'wrong-secret'))).status).toBe(401);
    expect((await s.transport.handleFetch(postRequest(textBody('x'), null))).status).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.messages).toHaveLength(0);
  });

  it('processes unsigned events without an appSecret, warning once', async () => {
    const s = await fetchSetup({ appSecret: undefined });
    await s.transport.handleFetch(postRequest(textBody('a'), null));
    await s.transport.handleFetch(postRequest(textBody('b', 'wamid.second'), null));
    await waitFor(() => s.messages.length === 2);
    // Once at start, and not again per request.
    expect(s.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('answers 405 for other methods and 400 for an oversized body', async () => {
    const s = await fetchSetup();
    const put = await s.transport.handleFetch(new Request(BASE, { method: 'PUT' }));
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, POST');
    const big = await s.transport.handleFetch(postRequest('a'.repeat(1024 * 1024 + 1)));
    expect(big.status).toBe(400);
  });
});
