/**
 * support-agent — the flagship wappa example: Claude + tools + Baileys.
 *
 * What it shows:
 *   - an Agent with zod-typed tools, cached knowledge and instructions-as-function
 *   - human handoff: escalate_to_human pauses the chat and pings an operator,
 *     who resumes it with '/resume <chatId>' (operator-only — without
 *     OPERATOR_CHAT_ID configured, /resume is disabled entirely)
 *   - rate limiting middleware and file-backed sessions that survive restarts
 *
 * Env (see .env.example): ANTHROPIC_API_KEY, OPERATOR_CHAT_ID.
 */
import { Agent, Bot, FileSessionStore, consoleLogger, defineTool, rateLimit } from '@wappajs/core';
import { AnthropicProvider } from '@wappajs/anthropic';
import { BaileysTransport } from '@wappajs/baileys';
import { z } from 'zod';
import { buildEscalationNotice, isOperator } from './operator.js';

const logger = consoleLogger();

/** WhatsApp JID of the human operator who receives escalations (DM chat id). */
const OPERATOR_CHAT_ID = process.env.OPERATOR_CHAT_ID;

if (!OPERATOR_CHAT_ID) {
  logger.warn(
    'OPERATOR_CHAT_ID is not set — escalations will pause chats without notifying anyone, ' +
      'and the operator-only /resume command is DISABLED (it fails closed). Set it in .env.'
  );
}

// A stand-in for your real order database. Tool results are stringified for the
// model, so returning plain objects is fine — no formatting needed.
const ORDERS: Record<string, { status: string; eta: string }> = {
  'A-1001': { status: 'shipped', eta: '2 days' },
  'A-1002': { status: 'processing', eta: '5 days' },
};

const checkOrderStatus = defineTool({
  name: 'check_order_status',
  description: 'Look up the current status and delivery estimate of an order by order number.',
  // zod schemas double as validation AND typing: `args` below is inferred as
  // { orderId: string }, and invalid model arguments are returned to the model
  // as an error string it can correct — the loop never crashes.
  parameters: z.object({ orderId: z.string().describe('Order number, e.g. A-1001') }),
  execute: ({ orderId }) =>
    ORDERS[orderId.toUpperCase()] ?? { error: `No order found with number ${orderId}` },
});

const escalateToHuman = defineTool({
  name: 'escalate_to_human',
  description:
    'Hand this conversation over to a human operator. Use when the customer asks for a ' +
    'person or you cannot resolve the issue with the available tools.',
  parameters: z.object({ reason: z.string().describe('One-line summary for the operator') }),
  execute: async ({ reason }, ctx) => {
    // The in-pipeline form of pausing: mutate the live session and the Bot's
    // own end-of-turn save persists it. From the NEXT message on, this chat
    // skips the router and agent entirely until an operator resumes it — the
    // current turn still finishes, so the model can say a proper goodbye.
    ctx.session.paused = true;
    if (OPERATOR_CHAT_ID) {
      // The notice sanitizes the customer-controlled push name (control chars
      // stripped, capped at 64 chars) and keeps the machine-actionable chatId
      // on its own line, derived only from ctx.message.chatId.
      await ctx.bot.send(
        OPERATOR_CHAT_ID,
        buildEscalationNotice(ctx.message.senderName, ctx.message.chatId, reason)
      );
    }
    return 'Escalated. Tell the customer a human will take over this chat shortly.';
  },
});

const agent = new Agent({
  // The prompt in two halves. `knowledge` is what never changes between messages
  // (the persona, the rules, a catalogue if you have one); the Anthropic provider
  // caches it at the API, so it costs a tenth on every message after the first.
  knowledge: [
    'You are a friendly, concise customer-support agent for Acme Gadgets.',
    'Answer order questions with check_order_status; never guess statuses.',
    'If you cannot help, or the customer asks for a human, call escalate_to_human.',
  ].join('\n'),
  // `instructions` is what changes: it is re-evaluated for every message, so it
  // can carry live context — the customer's name and the current time. Keep the
  // volatile lines here, not in the knowledge, or the cache never hits.
  instructions: (ctx) =>
    [
      `Customer name: ${ctx.message.senderName ?? 'unknown'}.`,
      `Current time: ${new Date().toISOString()}.`,
    ].join('\n'),
  provider: new AnthropicProvider(), // ANTHROPIC_API_KEY from env; model defaults apply
  tools: [checkOrderStatus, escalateToHuman],
});

const bot = new Bot({
  transport: new BaileysTransport({ authDir: './wappa-auth' }),
  agent,
  // File-backed sessions: history AND the paused flag survive a restart, so an
  // escalated chat stays with the human until it is explicitly resumed.
  sessions: new FileSessionStore('./sessions'),
  logger,
});

// Cap LLM spend per chat: over-limit messages are dropped before they ever
// reach the agent. (A production bot might notify only once per window.)
bot.use(
  rateLimit({
    windowMs: 60_000,
    max: 10,
    onLimit: (ctx) => void ctx.reply('You are sending messages too quickly — give me a minute.'),
  })
);

// Operator command: '/resume 15551234567@s.whatsapp.net'. Commands are matched
// before the agent, and the operator's own chat is never paused, so this works
// even while the customer's chat is handed off.
bot.command('/resume', async (ctx) => {
  // Operator only, failing CLOSED: without OPERATOR_CHAT_ID configured the
  // command is disabled — otherwise any stranger could unpause a handed-off
  // chat (see the startup warning).
  if (!isOperator(ctx.message.senderId, OPERATOR_CHAT_ID)) return;
  const target = ctx.state.commandArgs as string; // router sets this to the trimmed remainder
  if (!target) {
    await ctx.reply('Usage: /resume <chatId>');
    return;
  }
  await ctx.bot.resume(target); // lost-update-safe: serializes with that chat's pipeline
  await ctx.reply(`Resumed ${target} — the agent is answering there again.`);
});

bot.on('ready', (info) => logger.info(`support-agent ready as ${info.selfId ?? 'unknown'}`));

process.once('SIGINT', () => void bot.stop().then(() => process.exit(0)));

await bot.start();
