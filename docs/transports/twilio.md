# Twilio transport (`@wappajs/twilio`)

`TwilioTransport` runs your bot through **Twilio's WhatsApp Business API**. Twilio is a
WhatsApp **BSP** (Business Solution Provider): your WhatsApp number lives with Twilio,
inbound messages arrive as form-encoded webhooks, and outbound messages go through the
Twilio Messages REST API with basic auth. No Twilio SDK, just `node:http`,
`node:crypto`, and the global `fetch`.

Like the Cloud API, this is an **official, ToS-safe** path: no ban risk, fine for
production. Choose it when you already live in the Twilio ecosystem (SMS, Voice,
Studio) or want Twilio to own the Meta relationship; choose
[`@wappajs/cloud-api`](cloud-api.md) to talk to Meta directly. Twilio WhatsApp is
**DM-only**, so every mapped message has `isGroup: false` and `chatId === senderId` (the
sender address verbatim, e.g. `whatsapp:+15551234567`).

## Options

```ts
import { TwilioTransport } from '@wappajs/twilio';

const transport = new TwilioTransport({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,      // required: ACxxxx
  authToken: process.env.TWILIO_AUTH_TOKEN!,        // required: basic auth AND signature validation
  whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER!, // required: your Twilio WhatsApp sender,
                                                    //   with or without the 'whatsapp:' prefix
  port: 3000,                    // optional: start an internal node:http webhook server
  webhookPath: '/webhook',       // default
  webhookUrl: 'https://bot.example.com/webhook', // strongly recommended, see the proxy caveat
  validateSignature: true,       // default: set false ONLY in tests
  apiBaseUrl: 'https://api.twilio.com', // default (override for tests)
  logger,                        // default consoleLogger()
});
```

`accountSid` and `authToken` come from the Twilio console's account dashboard. The
`whatsapp:` prefix on `whatsappNumber` is optional, the transport normalizes it
(`'+14155238886'` and `'whatsapp:+14155238886'` are equivalent).

Setting `validateSignature: false` disables webhook authentication entirely and logs a
prominent warning on start. Anyone who discovers your webhook URL could then forge
inbound messages. It exists for tests only.

## Sandbox quickstart

Twilio ships a shared **WhatsApp sandbox** you can message within minutes, before any
sender registration:

1. In the [Twilio console](https://console.twilio.com), go to **Messaging → Try it out
   → Send a WhatsApp message**. The sandbox page shows the shared **sandbox number**
   (e.g. `+1 415 523 8886`) and your unique **join code** (`join <two-words>`).
2. From your phone, send that join code as a WhatsApp message to the sandbox number.
   Twilio confirms you've joined. (Sandbox connections expire after ~72 hours of
   inactivity, just send the join code again.)
3. Use the sandbox number as `whatsappNumber` and point the sandbox at your webhook:
   under **Messaging → Try it out → Send a WhatsApp message → Sandbox settings**, set
   **"When a message comes in"** to your public webhook URL (method `POST`), see the
   next sections for exposing one.
4. Start your bot and message the sandbox number from the joined phone.

The sandbox is for development: everyone who talks to your bot must join first, and the
number is shared with other Twilio developers.

## Production senders

For production you register **your own WhatsApp sender** with Twilio: in the console
under **Messaging → Senders → WhatsApp senders**, connect a Meta Business account,
verify your business, and register a phone number (a Twilio number or one you port in).
Twilio's [WhatsApp self sign-up guide](https://www.twilio.com/docs/whatsapp/self-sign-up)
walks through it. Once approved, put the registered number in `whatsappNumber` and set
the sender's inbound webhook to your bot's URL.

## Webhook setup

### Expose your webhook (dev tip: ngrok)

Twilio must reach your server over public HTTPS. For local development:

```bash
ngrok http 3000
```

Copy the `https://<something>.ngrok-free.app` URL and paste
`https://<something>.ngrok-free.app/webhook` into the sandbox (or sender)
**"When a message comes in"** field.

### The `webhookUrl` caveat (proxies, tunnels)

Twilio signs every webhook POST with an `X-Twilio-Signature` header computed over the
**exact public URL it requested** plus the sorted POST parameters, HMAC-SHA1-keyed with
your auth token. The transport recomputes and compares it (timing-safe); a missing or
wrong signature is answered **403** and never processed.

That makes validation depend on knowing the exact public URL. If `webhookUrl` is not
set, the transport reconstructs it as `'https://' + Host header + path` and **warns
once**: behind a proxy, load balancer, or tunnel that rewrites the `Host` header (or
terminates TLS elsewhere), the reconstruction can mismatch what Twilio actually signed
and every request gets rejected as 403. **Set `webhookUrl` to the exact public URL**
(scheme + host + path, e.g. your ngrok URL + `/webhook`) whenever anything sits between
Twilio and your process, and update it when your tunnel URL changes.

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
`handleRequest(req, res, rawBody?)` yourself. It handles webhook POSTs (405 for other
methods on the path) and returns `true` when the request's path matched (i.e. it was
handled).

`handleRequest` reads the raw request body itself **unless** you pass `rawBody`. Pass
it whenever a framework body-parser has already consumed the stream. The signature
check runs over the decoded params of these exact raw bytes.

**Express**: use `express.raw` with a wildcard `type` on the webhook path (Express's
default raw type is `application/octet-stream`; Twilio posts
`application/x-www-form-urlencoded`, so widen it) and pass `req.body` through:

```ts
import express from 'express';

const app = express();

// Keep the body raw on the webhook path, do NOT let express.urlencoded() touch it.
app.use('/webhook', express.raw({ type: '*/*' }));

app.post('/webhook', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined;
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
response. Route it yourself, on whatever path you like; the transport does no
`webhookPath` check here:

```ts
import { Hono } from 'hono';

const app = new Hono();
app.post('/api/whatsapp/twilio', (c) => transport.handleFetch(c.req.raw));

await bot.start();                                 // no internal server without `port`
export default { port: 3000, fetch: app.fetch };  // Bun
```

A Next.js route handler is one line: `export const POST = (req: Request) =>
transport.handleFetch(req);`. The semantics match `handleRequest`: 405 for anything but
POST, 400 for an unreadable or oversized body, 403 for a missing or invalid signature,
200 + empty TwiML for a valid post, with the message delivered after the response is
returned. Set `webhookUrl` to the exact public URL of the route you mounted: behind a
proxy, the request's own URL is not what Twilio signed.

### POST handling semantics

Valid webhook POSTs are acknowledged **immediately** with 200 and an empty TwiML body
(`<Response/>`, `Content-Type: text/xml`, so Twilio sends no auto-reply) and processed
asynchronously (Twilio retries slow webhooks). Request bodies are capped at **1 MiB**,
real Twilio webhooks are small form-encoded documents, and the buffering happens before
authentication, so the cap stays low; an over-limit body is answered with 400 and never
processed.

Mapped messages are handed to the pipeline **without awaiting each handler**: delivery
is non-blocking, so one chat's slow agent turn can't stall the webhook loop. Per-chat
ordering is still guaranteed by the Bot's per-chat queue (its enqueue is synchronous).

Twilio redelivers webhooks it considers failed, so the transport dedups: it keeps a
bounded set of recently seen `MessageSid`s (the most recent 1000) and skips a
redelivered sid with a debug log instead of running a duplicate agent turn.

Delivery-status callbacks (a `MessageStatus`/`SmsStatus` param with no inbound content)
are acknowledged and ignored; unmapped/contentless payloads are skipped silently with a
debug log.

## Inbound mapping

- `id` = `MessageSid`; `chatId` = `senderId` = `From` **verbatim** (e.g.
  `whatsapp:+15551234567`, ids are transport-specific and round-trip into `send()`);
  `senderName` from `ProfileName`; `isGroup` is always `false`; `timestamp` is the
  arrival time (Twilio sends no epoch)
- `Body` → `message.text` (template quick replies: `ButtonText` → `text`,
  `ButtonPayload` → `buttonId`)
- `NumMedia > 0` → `message.media`: a lazy `MediaRef` whose `download()` GETs
  `MediaUrl0` with basic auth (following redirects to the CDN) and resolves to a
  `Buffer`; `kind` derives from `MediaContentType0` (`image/webp` → sticker), and
  `audio/ogg` voice notes have `ptt: true`
- `Latitude`/`Longitude` → `message.location` (with `Label`/`Address` when present)
- `MessageType: 'reaction'` → `message.reaction` (emoji = `Body`, target =
  `OriginalRepliedMessageSid`); a non-reaction `OriginalRepliedMessageSid` →
  `message.quoted`
- the full decoded param bag is kept on `message.raw` as an escape hatch

## Outbound behavior

`send(chatId, content)` POSTs form-encoded to
`/2010-04-01/Accounts/{accountSid}/Messages.json` with basic auth. The `whatsapp:`
prefix is prepended to `To` when missing, so inbound chat ids round-trip verbatim.

- **Text** → `Body`.
- **Media**: must be a **public `http(s)` URL** → `MediaUrl` (its caption wins over
  `text` as `Body`). Twilio's Messages API has **no binary upload**: a Buffer or local
  file path makes `send` throw a clear `Error` telling you to host the file and pass a
  URL.
- **Buttons** → a **numbered text fallback** appended to the text (native Twilio
  buttons require pre-registered Content Templates, see the next section). The user
  answers with plain text, so match on titles with `hears()`, see the
  [buttons recipe](../recipes.md#portable-quick-reply-buttons).
- **Location** → `PersistentAction = geo:{lat},{lon}|{name}`.
- **`replyTo`** is skipped with a debug log (the Messages API has no quoted-reply
  support).

Any non-2xx response makes `send` throw an `Error` that includes the HTTP status and
the response body; on success `SendResult.id` is the message `sid`.

`sendTyping` and `markRead` are deliberately **absent**. Twilio does not expose typing
indicators or read receipts for WhatsApp, and the Bot feature-detects the missing
methods (`ctx.sendTyping()` is a silent no-op).

## The 24-hour session window and Content Templates

WhatsApp platform rules (they apply to the Cloud API too, and to the sandbox): a
business may send **free-form** messages only within **24 hours of the user's last
inbound message**. Outside that window, only **pre-approved templates** (on Twilio,
**Content Templates**) may be sent, and a free-form `send` fails (Twilio error 63016,
which surfaces as the thrown non-2xx `Error`).

wappa v0.1 sends free-form messages only. Content Templates (which are also what
native quick-reply buttons require) are **out of scope**. For a reply-driven bot this
is rarely a limitation: every user message opens a fresh 24-hour window. It matters for
**proactive** messages (`bot.send` to a chat that hasn't written recently). For those,
send the template through Twilio's Content API yourself, and let the user's reply bring
the conversation back into wappa.

## Capabilities vs the other transports

| Capability | [`@wappajs/baileys`](baileys.md) | [`@wappajs/cloud-api`](cloud-api.md) | `@wappajs/twilio` |
| --- | --- | --- | --- |
| Official / ToS-safe | no (ban risk) | **yes** | **yes** |
| Groups | yes | no (DM-only) | no (DM-only) |
| Quick-reply buttons | numbered text fallback | native (max 3), `buttonId` round-trips | numbered text fallback only |
| Typing indicator | yes | best-effort | no (`sendTyping` absent) |
| Read receipts | yes | yes | no (`markRead` absent) |
| Outbound media | Buffer, URL, or local path | Buffer, URL, or local path (uploads) | **public URL only** |
| Quoted replies (`replyTo`) | skipped | native | skipped |
| Proactive messages | any time | 24h window / templates | 24h window / templates (templates out of scope) |
