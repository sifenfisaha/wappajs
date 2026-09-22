# support-agent

The flagship wappa example: a Claude-powered customer-support agent on a personal
WhatsApp number (Baileys). It shows:

- zod-typed tools: `check_order_status` (fake DB) and `escalate_to_human`
- human handoff: escalation sets `ctx.session.paused = true` and notifies an operator
  chat; the operator sends `/resume <chatId>` to hand the chat back to the agent
  (operator-only — without `OPERATOR_CHAT_ID` set, `/resume` is disabled)
- the prompt in two halves: `knowledge` (the persona and rules, cached at the API by the
  Anthropic provider) and instructions-as-function (injects the customer's name and the
  current time, the part that changes)
- `rateLimit` middleware and a `FileSessionStore` (history + paused flag survive
  restarts, in `./sessions`)

Try it: ask "where is order A-1001?", or "let me talk to a human".

## Env vars

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — your Anthropic API key (read by the SDK).
- `OPERATOR_CHAT_ID` — WhatsApp JID of the human operator who receives escalations,
  e.g. `15551234567@s.whatsapp.net`. Optional — but without it escalations only pause
  the chat (nobody is notified) and `/resume` is **disabled**: the command fails
  closed, since with no configured operator nobody is authorized to unpause chats
  (a startup warning says so).

## Run

From the repo root:

```sh
npm install
npm run build
cd examples/support-agent
cp .env.example .env     # then edit it
npm start                # prints a QR code — scan it with WhatsApp on your phone
```

> Baileys is an unofficial WhatsApp client: it may violate WhatsApp's ToS and can get
> numbers banned. Use a number you can afford to lose; prefer the Cloud API transport
> for production (see `examples/cloud-api-agent`).
