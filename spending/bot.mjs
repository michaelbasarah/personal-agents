/**
 * Personal spending bot — you type what you spent in Discord, it lands in your Google Sheet.
 *
 * Structure is lifted from the pioNox Discord bot (Services/ai-employees/app/discord.mjs): one
 * process, one bot identity, routes by channel, serialises per channel, chunks long replies, and
 * logs-then-exits on a fatal so a supervisor restarts it. What's different is the job — no persona,
 * no conversation memory. Each message is a self-contained transaction: parse → append → confirm.
 *
 * Two guards this bot has that the pioNox one doesn't, because this is personal financial data:
 *   - a hard user allowlist (SPEND_USER_IDS): the bot ignores everyone else, even in its own channel
 *   - a single, explicitly-named channel; it never listens in DMs or anywhere it wasn't invited
 *
 * Run:  npm run spending    (needs DISCORD_TOKEN, GEMINI_API_KEY, SPEND_SHEET_ID, Google SA creds)
 */
import "dotenv/config";
import { Client, GatewayIntentBits, ActivityType } from "discord.js";
import { log } from "../lib/log.mjs";
import { appendSpend, readSpendRows, deleteRow } from "../lib/sheets.mjs";
import { parseExpense, todayIn, CATEGORIES } from "./parse.mjs";

const TZ = process.env.SPEND_TZ || "Asia/Jakarta";
const CURRENCY = process.env.SPEND_CURRENCY || "IDR";

// --- per-channel serialization: two fast messages must not race the same sheet append ---
const queues = new Map();
function serialized(key, fn) {
  const tail = queues.get(key) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  queues.set(key, run.then(() => {}, () => {}));
  return run;
}

// --- money + date formatting ---
const fmt = (amount, currency = CURRENCY) => {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "IDR" ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString("en-US")}`;
  }
};

/** Sum by currency — you might log an occasional USD charge and adding it to rupiah is nonsense. */
function totals(rows) {
  const byCurrency = new Map();
  for (const r of rows) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.amount);
  return [...byCurrency].map(([c, sum]) => fmt(sum, c)).join(" + ") || fmt(0);
}

function byCategory(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + r.amount);
  return [...m].sort((a, b) => b[1] - a[1]);
}

// --- the last write, so `!undo` has something to take back (in-memory; resets on restart) ---
let lastWrite = null; // { rows: number[], label: string }

const HELP = `**Spending bot**
Just type what you spent — no format needed:
\`kopi 25k\` · \`grab ke bandara 45rb gopay\` · \`kemarin belanja indomaret 187k\` · \`lunch 60k, parkir 5k\`

Commands:
\`!today\` — today's total    \`!week\` — last 7 days    \`!month\` — this month, by category
\`!undo\` — remove the last thing I logged
\`!cats\` — the category list
Currency defaults to ${CURRENCY}, dates to ${TZ}.`;

// ---------------------------------------------------------------- commands

async function cmdToday() {
  const today = todayIn(TZ);
  const rows = (await readSpendRows()).filter((r) => r.date === today);
  if (!rows.length) return `Nothing logged today (${today}). 🫧`;
  const lines = rows.map((r) => `• ${fmt(r.amount, r.currency)} — ${r.merchant || r.note || r.category}`);
  return `**Today — ${totals(rows)}**\n${lines.join("\n")}`;
}

async function cmdWeek() {
  // Count back from TODAY-IN-TZ, not from UTC now — in Jakarta those are different days for 7 hours.
  const since = new Date(`${todayIn(TZ)}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 6);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = (await readSpendRows()).filter((r) => r.date >= sinceStr);
  if (!rows.length) return "Nothing logged in the last 7 days.";
  const days = new Set(rows.map((r) => r.date)).size;
  return `**Last 7 days — ${totals(rows)}** (${rows.length} entries over ${days} days)\n` +
    byCategory(rows).map(([c, s]) => `• ${c}: ${fmt(s)}`).join("\n");
}

async function cmdMonth() {
  const month = todayIn(TZ).slice(0, 7);
  const rows = (await readSpendRows()).filter((r) => r.date.startsWith(month));
  if (!rows.length) return `Nothing logged in ${month} yet.`;
  const top = byCategory(rows).map(([c, s]) => `• ${c}: ${fmt(s)}`).join("\n");
  return `**${month} — ${totals(rows)}** (${rows.length} entries)\n${top}`;
}

/**
 * Undo is only safe on the tail of the sheet: deleting row 12 renumbers everything under it, so if
 * anything landed after our write (another device, a manual edit) we refuse rather than delete the
 * wrong line. Rows go bottom-up for the same reason.
 */
async function cmdUndo() {
  if (!lastWrite) return "Nothing to undo in this session.";
  const rows = await readSpendRows();
  const lastInSheet = rows.at(-1)?.row ?? 1;
  if (lastInSheet !== Math.max(...lastWrite.rows)) {
    const stale = lastWrite;
    lastWrite = null;
    return `⚠️ The sheet changed since I logged ${stale.label} — not touching it. Delete that row by hand if you still want it gone.`;
  }
  for (const row of [...lastWrite.rows].sort((a, b) => b - a)) await deleteRow(row);
  const label = lastWrite.label;
  lastWrite = null;
  return `↩️ Removed ${label}.`;
}

const COMMANDS = {
  "!help": async () => HELP,
  "!today": cmdToday,
  "!week": cmdWeek,
  "!month": cmdMonth,
  "!undo": cmdUndo,
  "!cats": async () => `Categories:\n${CATEGORIES.map((c) => `• ${c}`).join("\n")}`,
};

// ---------------------------------------------------------------- the expense path

async function handleExpense(msg) {
  await msg.channel.sendTyping();

  let parsed;
  try {
    parsed = await parseExpense(msg.content);
  } catch (e) {
    log.error("parse_failed", { msg: e?.message });
    return "⚠️ My brain hiccuped reading that — try again?";
  }

  if (!parsed.items.length) {
    // Not an expense, or an amount is missing. Say so cheaply; never write a guess.
    return parsed.question || "🤔 I couldn't find an amount in that. How much was it?";
  }

  const written = [];
  for (const item of parsed.items) {
    try {
      const { row } = await appendSpend(item);
      written.push({ item, row });
    } catch (e) {
      log.error("append_failed", { msg: e?.message, amount: item.amount });
      return `⚠️ Parsed it but couldn't write to the sheet: ${e.message.slice(0, 120)}`;
    }
  }

  const label = written
    .map(({ item }) => `${fmt(item.amount, item.currency)} ${item.merchant || item.note || item.category}`.trim())
    .join(" + ");
  lastWrite = { rows: written.map((w) => w.row).filter(Boolean), label };

  const lines = written.map(({ item }) => {
    const where = item.merchant || item.note || "—";
    const extra = [item.method, item.date !== todayIn(TZ) ? item.date : null].filter(Boolean).join(" · ");
    return `✅ ${fmt(item.amount, item.currency)} — ${where} · _${item.category}_${extra ? ` · ${extra}` : ""}`;
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------- discord wiring

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

let spendCh = null;
// Empty allowlist = nobody. Personal finances default to closed, not open.
const ALLOWED = new Set((process.env.SPEND_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));

client.on("ready", () => {
  log.info("spending_ready", { msg: `logged in as ${client.user.tag}` });
  client.user.setPresence({ activities: [{ name: "your wallet", type: ActivityType.Watching }], status: "online" });

  const guild = client.guilds.cache.first();
  spendCh =
    (process.env.SPEND_CHANNEL_ID && client.channels.cache.get(process.env.SPEND_CHANNEL_ID)) ||
    guild?.channels.cache.find((c) => c.name === (process.env.SPEND_CHANNEL_NAME || "spending")) ||
    null;

  log.info("spending_channel", { channel: spendCh?.name ?? "NOT FOUND", allowlisted: ALLOWED.size });
  if (!spendCh) log.warn("spending_channel_missing", { msg: "set SPEND_CHANNEL_ID, or make a #spending channel" });
  if (!ALLOWED.size) log.warn("spending_no_allowlist", { msg: "SPEND_USER_IDS is empty — the bot will ignore everyone" });
});

client.on("messageCreate", (msg) => {
  if (msg.author.bot) return;
  const parent = msg.channel?.isThread?.() ? msg.channel.parentId : msg.channelId;
  if (!spendCh || parent !== spendCh.id) return;
  if (!ALLOWED.has(msg.author.id)) return log.warn("spending_not_allowed", { user: msg.author.id });

  const text = msg.content.trim();
  if (!text) return;

  serialized(msg.channelId, async () => {
    try {
      const cmd = COMMANDS[text.toLowerCase().split(/\s+/)[0]];
      const reply = cmd ? await cmd() : await handleExpense(msg);
      for (const part of chunk(reply)) await msg.reply({ content: part, allowedMentions: { repliedUser: false } });
    } catch (e) {
      log.error("spending_handler_failed", { msg: e?.message?.slice(0, 160) });
      await msg.reply({ content: `⚠️ ${e.message?.slice(0, 200) || "Something broke."}`, allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  });
});

/** Discord caps a message at 2000 chars; split on line breaks where possible. */
function chunk(text, size = 1900) {
  if (text.length <= size) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

// --- lifecycle: clean disconnect on SIGTERM, log-then-exit on a fatal so a supervisor restarts us ---
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("spending_shutdown", { signal });
  try { client.destroy(); } catch { /* best-effort */ }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function fatal(kind, reason) {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error(kind, { msg: err.message, stack: err.stack });
  process.exit(1);
}
process.on("uncaughtException", (e) => fatal("spending_uncaught", e));
process.on("unhandledRejection", (e) => fatal("spending_unhandled_rejection", e));

for (const key of ["DISCORD_TOKEN", "GEMINI_API_KEY", "SPEND_SHEET_ID"]) {
  if (!process.env[key]) {
    log.error("spending_missing_env", { msg: `${key} is not set — see .env.example` });
    process.exit(1);
  }
}
client.login(process.env.DISCORD_TOKEN);
