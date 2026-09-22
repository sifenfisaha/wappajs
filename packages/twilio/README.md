# @wappajs/twilio

Twilio **WhatsApp** transport for [wappa](https://github.com/sifenfisaha/wappajs). Run an
agent on a Twilio-provisioned WhatsApp number (BSP). Implemented against Twilio's
form-encoded webhook and Messages REST API directly, with no Twilio SDK dependency.

```bash
npm install @wappajs/core @wappajs/twilio
```

```ts
import { Agent, Bot } from '@wappajs/core';
import { TwilioTransport } from '@wappajs/twilio';

const transport = new TwilioTransport({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  whatsappNumber: 'whatsapp:+14155238886',
  port: 3000,
});

const bot = new Bot({
  transport,
  agent: new Agent({ instructions: '...', provider: myProvider }),
});

await bot.start();
```

## Features

- `X-Twilio-Signature` webhook validation
- Parses Twilio's `application/x-www-form-urlencoded` webhooks into wappa's message model
- Media in and out via Twilio's media URLs
- Works with the Twilio WhatsApp Sandbox for development
- Runs its own `node:http` server, mounts into yours with `handleRequest`, or into any
  fetch-style host (Bun, Deno, Workers, Hono, Next.js) with `handleFetch(request)`

Setup walkthrough: https://github.com/sifenfisaha/wappajs/blob/main/docs/transports

## License

MIT
