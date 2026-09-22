# Recipes

Practical patterns built from the primitives in [concepts.md](concepts.md). Everything
here is plain wappa, with no extra framework features involved.

## Human handoff

Give the agent an escalation tool that pauses the chat and pings an operator; give the
operator a command to hand the chat back. While `session.paused` is true the router and
agent are skipped, so a human can reply from the linked phone or business inbox without
the bot talking over them.

```ts
import { Agent, Bot, defineTool } from '@wappajs/core';
import { z } from 'zod';

const OPERATOR_CHAT_ID = process.env.OPERATOR_CHAT_ID!; // e.g. a Baileys JID or a phone number

const escalate = defineTool({
  name: 'escalate_to_human',
  description: 'Hand this conversation to a human operator when the user asks for one or you cannot help.',
  parameters: z.object({ reason: z.string() }),
  async execute({ reason }, ctx) {
    // In-pipeline form: the Bot's own save persists it, no race with the session store.
    ctx.session.paused = true;
    await ctx.bot.send(
      OPERATOR_CHAT_ID,
      `Chat ${ctx.message.chatId} needs a human.\nReason: ${reason}\nReply "/resume ${ctx.message.chatId}" here when done.`,
    );
    return 'The user has been handed to a human operator. Say goodbye briefly.';
  },
});

// Operator-side command (the operator messages the bot from OPERATOR_CHAT_ID):
bot.command('/resume', async (ctx) => {
  if (ctx.message.chatId !== OPERATOR_CHAT_ID) return; // only the operator may resume
  const chatId = ctx.state.commandArgs as string;      // '/resume <chatId>'
  if (!chatId) {
    await ctx.reply('Usage: /resume <chatId>');
    return;
  }
  await ctx.bot.resume(chatId);
  await ctx.reply(`Resumed ${chatId}.`);
});
```

From outside the pipeline (an admin HTTP endpoint, a cron job), use `bot.pause(chatId)` /
`bot.resume(chatId)`. They serialize safely with message processing (see
[pause semantics](concepts.md#pause-and-handoff)).

## Media handling

Inbound media is lazy: the message carries a `MediaRef` and nothing is transferred until
you call `download()`, which resolves to a `Buffer`.

```ts
bot.use(async (ctx, next) => {
  const media = ctx.message.media;
  if (media?.kind === 'image') {
    const bytes = await media.download();          // Buffer
    ctx.logger.info('got image', { size: bytes.length, mimetype: media.mimetype });
    ctx.state.imageBytes = bytes;                  // pass downstream for this message only
  }
  await next();
});
```

`MediaRef` also carries `mimetype`, `filename` (documents), and `ptt` (true for voice
notes). Messages that are media-only have no `text`, so they skip routing and the agent, and
a middleware like the one above is the place to react; a media message **with a caption**
does reach the agent (rendered as `[image] the caption`).

Outbound media is a payload field; `data` accepts a Buffer, an `https:` URL, or a local
file path:

```ts
await ctx.reply({
  media: { kind: 'image', data: 'https://example.com/receipt.png', caption: 'Your receipt' },
});

await bot.send(chatId, {
  media: {
    kind: 'document',
    data: pdfBuffer,                    // Buffer
    mimetype: 'application/pdf',        // REQUIRED for Buffer/path uploads on Cloud API
    // Note: Twilio accepts URL media only, Buffer/path data throws there; host the
    // file and pass its public https URL as `data` instead.
    filename: 'invoice.pdf',
  },
});
```

## Group mention filtering (`bot.selfId`)

In groups you usually want the bot to answer only when addressed. `bot.selfId` is the
transport's own id once connected (on Baileys a JID like `15551234567:3@s.whatsapp.net`);
WhatsApp mentions appear in the text as `@<number>`:

```ts
bot.use(async (ctx, next) => {
  const { isGroup, text } = ctx.message;
  const selfId = ctx.bot.selfId;
  if (isGroup && selfId) {
    const selfNumber = selfId.split(/[:@]/)[0];              // '15551234567'
    if (!text?.includes(`@${selfNumber}`)) return;           // not mentioned, stop the chain
    // Strip the mention so the agent sees a clean question:
    ctx.message.text = text.replaceAll(`@${selfNumber}`, '').trim();
  }
  await next();
});
```

For exact mention metadata on Baileys, the raw message is available as an escape hatch
at `ctx.message.raw` (`contextInfo.mentionedJid`). The Cloud API and Twilio are DM-only,
so this middleware is a no-op there. To ignore groups entirely, skip the middleware and set
`ignoreGroups: true` on the Bot instead.

## Proactive and scheduled messages

`bot.send(chatId, content)` works any time after `start()`, with no inbound message needed.
Scheduling in v0.1 is plain JavaScript:

```ts
await bot.start();

const timer = setInterval(() => {
  bot.send(DIGEST_CHAT_ID, 'Daily digest: all systems nominal.').catch((err) => {
    // Baileys rejects sends while disconnected/reconnecting, log and let the next tick retry.
    console.error('digest send failed:', err);
  });
}, 24 * 60 * 60 * 1000);

process.on('SIGINT', async () => {
  clearInterval(timer);
  await bot.stop(); // drains in-flight turns, saves sessions, stops the transport
  process.exit(0);
});
```

Two caveats: on Baileys, sends while disconnected reject (catch them, as above); on the
Cloud API and Twilio, business-initiated messages outside the 24-hour customer service
window must be template messages. Plain proactive texts only reach users who wrote to
you recently.

## Voice-note transcription middleware (sketch)

wappa has no built-in transcription (see the roadmap), but it is a small middleware: spot
a voice note, download it, transcribe it with any STT service, and substitute the text
before the router and agent run.

```ts
bot.use(async (ctx, next) => {
  const media = ctx.message.media;
  if (media?.kind === 'audio' && media.ptt) {
    const audio = await media.download();                    // Buffer (typically ogg/opus)
    const transcript = await transcribe(audio, media.mimetype); // your STT call goes here
    ctx.message.text = transcript;
    // Drop the media so the agent sees plain text instead of '[voice note] <transcript>':
    delete ctx.message.media;
  }
  await next();
});
```

`transcribe` is whatever you like: a hosted speech API or a local whisper.cpp server.
Register this middleware **before** anything that reads `ctx.message.text` so commands
and `hears()` work on the transcript too.

## Rate limiting

Core ships a fixed-window per-chat limiter as middleware:

```ts
import { rateLimit } from '@wappajs/core';

bot.use(rateLimit({
  windowMs: 60_000,  // default
  max: 20,           // default: messages per window per chat
  onLimit: (ctx) => ctx.reply('You are sending messages too quickly, give me a minute.'),
}));
```

Over-limit messages never reach later middleware, routes, or the agent (`next()` is not
called), which is what protects your LLM bill. The counter is per `chatId` and resets
when the window elapses. Register it early. Only middleware registered before it runs
for dropped messages. For a global or persistent limiter, write your own middleware on
the same pattern and keep state wherever you need it.

## Portable quick-reply buttons

`OutboundPayload.buttons` (max 3) renders differently per transport: the Cloud API shows
native buttons and the reply comes back with `buttonId` set; Baileys and Twilio render a
numbered text fallback and the reply is plain text (on Twilio, native buttons require
pre-registered Content Templates, which wappa does not use in v0.1). Portable code
therefore matches on **titles**:

```ts
await ctx.reply({
  text: 'How would you like to pay?',
  buttons: [
    { id: 'pay-card', title: 'Card' },
    { id: 'pay-cash', title: 'Cash' },
  ],
});

bot.hears('card', handleCard); // matches the tapped title on Cloud API…
bot.hears('cash', handleCash);
bot.hears('1', handleCard);    // …and the numbered fallback replies on Baileys/Twilio
bot.hears('2', handleCash);
```

If you only target the Cloud API, check `ctx.message.buttonId` in a middleware or
handler instead. It round-trips the button `id` exactly.

## Keeping a transcript

Sessions hold the model's windowed history, which rolls. A support desk wants the whole
conversation, in order, with who said what, and that is two lines of middleware: record
the inbound message, and wrap `ctx.reply` so every outbound reply is recorded on its way
out. Nothing in the framework needs to know.

```ts
bot.use(async (ctx, next) => {
  const chatId = ctx.message.chatId;
  await transcript.append(chatId, { from: 'customer', text: ctx.message.text ?? '[media]' });

  const reply = ctx.reply;
  ctx.reply = async (content) => {
    const result = await reply(content);
    const text = typeof content === 'string' ? content : (content.text ?? '[media]');
    await transcript.append(chatId, { from: 'assistant', text, id: result.id });
    return result;
  };

  await next();
});
```

`bot.send` from outside the pipeline (an operator answering from a dashboard) does not
pass through the middleware, so record those where you call them.

## A database session store

The built-in stores are a `Map` and one JSON file per chat. Production usually wants the
sessions where the rest of the data is, and the interface is three methods over one JSON
document per chat, so any database works. Postgres, with an upsert:

```ts
import type { SessionData, SessionStore } from '@wappajs/core';

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly sql: Sql) {}

  async get(chatId: string): Promise<SessionData | undefined> {
    const [row] = await this.sql`select session from chat_session where chat_id = ${chatId}`;
    return row?.session as SessionData | undefined;
  }

  async set(chatId: string, data: SessionData): Promise<void> {
    await this.sql`
      insert into chat_session (chat_id, session, paused, updated_at)
      values (${chatId}, ${this.sql.json(data)}, ${data.paused ?? false}, now())
      on conflict (chat_id) do update
        set session = excluded.session, paused = excluded.paused, updated_at = now()`;
  }

  async delete(chatId: string): Promise<void> {
    await this.sql`delete from chat_session where chat_id = ${chatId}`;
  }
}
```

Store the document whole: `history` (including any `providerData` a provider attached
to its turns), `data`, `paused` and `updatedAt` all travel together, and the Bot reads
and writes the session exactly once per message, so a row per chat is the right grain.
Keeping `paused` in its own column as well, as above, lets a dashboard list handed-over
chats without opening every document.
