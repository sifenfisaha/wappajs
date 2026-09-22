# @wappajs/cloud-api

Official **WhatsApp Cloud API** transport for
[wappa](https://github.com/sifenfisaha/wappajs): a Meta Business webhook receiver plus Graph
API sender, implemented directly against the HTTP API (no Meta SDK dependency).

```bash
npm install @wappajs/core @wappajs/cloud-api
```

```ts
import { Agent, Bot } from '@wappajs/core';
import { CloudApiTransport } from '@wappajs/cloud-api';

const transport = new CloudApiTransport({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
  appSecret: process.env.WHATSAPP_APP_SECRET, // strongly recommended
  port: 3000,                                 // starts a node:http webhook server
});

const bot = new Bot({
  transport,
  agent: new Agent({ instructions: '...', provider: myProvider }),
});

await bot.start();
```

## Features

- Webhook verification handshake (`hub.challenge`) handled for you
- `X-Hub-Signature-256` request verification when `appSecret` is set;
  `verifySignature`, `computeSignature` and `readRawBody` are exported for custom servers
- Normalizes Cloud API payloads into wappa's message model (text, media, replies)
- Bring your own HTTP server, or let the transport start one; fetch-style hosts (Bun,
  Deno, Workers, Hono, Next.js) mount `handleFetch(request)`

Meta dashboard setup (app, phone number, webhook, app secret) is walked through in
https://github.com/sifenfisaha/wappajs/blob/main/docs/transports/cloud-api.md

## License

MIT
