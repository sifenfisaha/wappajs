# Cloud API transport (`@wappajs/cloud-api`)

`CloudApiTransport` speaks the **official WhatsApp Cloud API**: inbound messages arrive
via a Meta webhook, outbound messages go out through the Graph API. No Meta SDK, just
`node:http`, `node:crypto`, and the global `fetch`.

This is the transport to use for production: official, supported, no ban risk.
One structural difference from Baileys: **the Cloud API is DM-only**, so every mapped
message has `isGroup: false` and `chatId === senderId` (the sender's phone number, e.g.
`15551234567`).

## Options

```ts
import { CloudApiTransport } from '@wappajs/cloud-api';

const transport = new CloudApiTransport({
  accessToken: '...',            // required: Graph API access token
  phoneNumberId: '...',          // required: the WhatsApp business phone number id
  verifyToken: '...',            // required: webhook verify token YOU invent
  appSecret: '...',              // strongly recommended: enables signature verification
  port: 3000,                    // optional: start an internal node:http webhook server
  webhookPath: '/webhook',       // default
  graphApiVersion: 'v23.0',      // default
  baseUrl: 'https://graph.facebook.com', // default (override for tests)
  logger,                        // default consoleLogger()
});
```

If `appSecret` is omitted the transport still works but **skips signature
verification** and logs a prominent warning. Anyone who discovers your webhook URL can
forge inbound events. Set it.

## Meta dashboard walkthrough

You need a Meta developer app with the WhatsApp product. Step by step:

### 1. Create the app

1. Go to <https://developers.facebook.com/apps> and click **Create app**.
2. Pick the **Business** use case / app type, name the app, and create it.
3. On the app dashboard, find **WhatsApp** in the product list and click **Set up**.
   You'll be asked to connect (or create) a Meta Business portfolio.

### 2. Phone number, access token, phone number id

Under **WhatsApp → API Setup**:

- Meta provisions a free **test number**. Its **Phone number ID** (a long numeric id,
  not the phone number itself) is displayed right there: that's your `phoneNumberId`.
- A **temporary access token** (valid ~24h) is shown at the top: fine for a first run.
  For anything longer-lived, create a **system user** in Meta Business Settings, assign
  it the WhatsApp app with the `whatsapp_business_messaging` permission, and generate a
  permanent token: that's your `accessToken`.
- While on the test number, you must add each recipient phone number to the **allowed
  recipients** list on the same page before the API will deliver to it.

### 3. Invent a verify token

`verifyToken` is an arbitrary secret string you make up (e.g. the output of
`openssl rand -hex 16`). You give it to both the transport (option above) and the Meta
dashboard (next step); Meta echoes it back during webhook verification.

### 4. Expose your webhook (dev tip: ngrok)

Meta must reach your server over public HTTPS. For local development:

```bash
ngrok http 3000
```

Copy the `https://<something>.ngrok-free.app` URL. Start your bot first (`port: 3000`),
so the verification handshake in the next step can succeed.

### 5. Configure and verify the webhook

Under **WhatsApp → Configuration → Webhook**, click **Edit** and enter:

- **Callback URL**: `https://<your-domain>/webhook` (the transport's `webhookPath`,
  default `/webhook`)
- **Verify token**: the exact string from step 3

When you save, Meta sends `GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`.
The transport answers 200 with the challenge when `hub.mode === 'subscribe'` and the
token matches, else 403. You'll see `cloud-api: webhook verification succeeded` in your
logs.

### 6. Subscribe to the `messages` field

Still under **Webhook**, click **Manage** and subscribe to the **`messages`** webhook
field. Without this subscription Meta never delivers inbound messages.

### 7. App secret (signature verification)

Under **App settings → Basic**, reveal the **App secret** and pass it as `appSecret`.
Every webhook `POST` then carries an `X-Hub-Signature-256` header, an HMAC-SHA256 of
the **raw body bytes** keyed with the app secret. The transport verifies it with a
timing-safe compare and answers **401** without processing when it's missing or wrong.

## Running the webhook server

### Built-in server (easiest)

Set `port` and the transport starts its own `node:http` server on `start()`, routing
every request through `handleRequest` and answering 404 for unmatched paths:

```ts
const bot = new Bot({ transport /* port: 3000 set above */, agent });
await bot.start();
```

With `port: 0` the OS picks an ephemeral port, read it from
`transport.httpServer.address()` (useful in tests).

### Mounting into your own server

Without `port`, `start()` only validates config; you mount
`handleRequest(req, res, rawBody?)` yourself. It handles the GET verification handshake
and POST event delivery, and returns `true` when the request's path matched (i.e. it was
handled).

`handleRequest` reads the raw request body itself **unless** you pass `rawBody`. Pass it
whenever a framework body-parser has already consumed the stream. The HMAC signature
check always runs over these exact raw bytes, so it must be the raw body, not re-encoded
JSON.

**Express**: use `express.raw` with a wildcard `type` on the webhook path (Express's
default raw type is `application/octet-stream`; the webhook posts JSON, so widen it) and
pass `req.body` through:

```ts
import express from 'express';

const app = express();

// Keep the body raw on the webhook path, do NOT let express.json() touch it.
app.use('/webhook', express.raw({ type: '*/*' }));

app.all('/webhook', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined; // GET has no body
  const handled = await transport.handleRequest(req, res, rawBody);
  if (!handled) res.status(404).end();
});

await bot.start();       // registers handlers; no internal server without `port`
app.listen(3000);
```

For a plain `node:http` server, just call `handleRequest(req, res)` (no `rawBody`
needed, the transport reads the stream) and 404 anything it didn't handle.

### Mounting into a fetch-style server (Bun, Deno, Workers, Hono, Next.js)

Runtimes and frameworks that speak WHATWG `Request`/`Response`, such as Bun, Deno,
Cloudflare Workers, Hono, Next.js route handlers, SvelteKit and Remix, have no
`IncomingMessage` to hand over. `handleFetch(request)` takes the request and returns the
response: GET answers the verification handshake, POST takes deliveries. Route both
methods yourself, on whatever path you like; the transport does no `webhookPath` check
here:

```ts
import { Hono } from 'hono';

const app = new Hono();
app.get('/api/whatsapp/meta', (c) => transport.handleFetch(c.req.raw));
app.post('/api/whatsapp/meta', (c) => transport.handleFetch(c.req.raw));

await bot.start();                                 // no internal server without `port`
export default { port: 3000, fetch: app.fetch };  // Bun
```

In a Next.js route handler, export the same function twice: `const handler = (req:
Request) => transport.handleFetch(req); export { handler as GET, handler as POST };`. The
semantics match `handleRequest`: 200 + `hub.challenge` or 403 for the handshake, 401 for
a missing or invalid signature, 400 for an unreadable or oversized body, 405 for other
methods, and 200 for a valid post with the events delivered after the response is
returned. The signature is checked over the raw bytes, so do not parse the body before
handing the request over.

### POST handling semantics

Valid webhook POSTs are acknowledged with **200 immediately** and processed
asynchronously (Meta retries slow webhooks). Request bodies are capped at **1 MiB**,
real Cloud API events are small JSON documents, and the buffering happens before
authentication, so the cap stays low; an over-limit body is answered with 400 and
never processed.

`entry[].changes[].value.messages[]` are mapped and handed to the pipeline **in order,
without awaiting each handler**: delivery is non-blocking, so one chat's slow agent
turn can't stall delivery to every other chat in the same POST. Per-chat ordering is
still guaranteed by the Bot's per-chat queue (its enqueue is synchronous).

Meta delivers webhooks **at-least-once**, so the transport dedups redeliveries: it
keeps a bounded set of recently seen message ids (the most recent 1000 wamids) and
skips a redelivered id with a debug log instead of running a duplicate agent turn.

`statuses` events (delivery/read receipts) are ignored; unmapped message types
(contacts, order, system, unsupported, unknown) are skipped silently with a debug log.

## Inbound mapping

- `text.body` → `message.text`
- interactive `button_reply` / `list_reply` → `text` = the reply **title**, `buttonId` =
  the reply **id** (this is the transport where button ids round-trip)
- template `button` presses → `text` = the button text, `buttonId` = its payload
- image/audio/video/document/sticker → `message.media`: a lazy `MediaRef` whose
  `download()` does the two-hop Graph fetch (`GET /{media-id}` for the URL, then GET
  that URL with the Bearer token) and resolves to a `Buffer`; captions become
  `message.text`; voice notes have `ptt: true`
- location → `message.location`; reaction → `message.reaction`; `context` → `message.quoted`
- `senderName` from `contacts[0].profile.name`; `timestamp` is the webhook's Unix
  seconds × 1000; the raw webhook message object is kept on `message.raw`

## Outbound behavior

`send(chatId, content)` POSTs to `/{phoneNumberId}/messages`. When a payload combines
several fields the precedence is **buttons > media > location > text**:

- **Text** → `{ type: 'text', text: { body, preview_url: true } }`.
- **Buttons** → a native interactive button message with up to **3** reply buttons
  (more throws), using `text` as the required message body. Replies come back with
  `buttonId` set, see the [buttons recipe](../recipes.md#portable-quick-reply-buttons).
  Media sent **alongside buttons** becomes the interactive message **header**
  (image/video/document; Buffers and local paths are uploaded first, like plain media
  sends), except audio and sticker, which the Cloud API cannot render as a header:
  those are **dropped with a warning** and the button message is sent without media.
- **Media**: an `https:` URL is sent by link; a Buffer or local file path is first
  uploaded via `/{phoneNumberId}/media` (multipart) and sent by id. Uploads **require**
  `mimetype` (throws otherwise). Captions apply to image/video/document (not
  audio/sticker); `filename` applies to documents.
- **Location** → a location message.
- **`replyTo`** → `context: { message_id }` (a real quoted reply, Cloud API supports it).

Any non-2xx Graph response makes `send` throw an `Error` that includes the HTTP status
and the response body.

`sendTyping(chatId, true)` needs an inbound message id (Cloud API ties typing to marking
a message read): the transport remembers the last inbound id per chat (bounded to the
1000 most recently active chats) and no-ops when it has none. `sendTyping(chatId, false)`
is always a no-op, the indicator auto-clears. Typing is **best-effort**: a Graph API
failure is debug-logged, never thrown, so a typing indicator can't kill an agent turn.
`markRead` marks a specific message read.
