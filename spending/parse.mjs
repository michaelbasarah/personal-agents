/**
 * Natural language → structured expenses, via Gemini with a response schema.
 *
 * The whole point of this agent is that logging a purchase costs you one sloppy sentence, not a
 * form. So the parser has to absorb Indonesian shorthand ("kopi 25rb gopay"), English, mixed
 * ("grab ke bandara 45k"), relative dates ("kemarin"), several expenses in one line, and still say
 * "I don't know" instead of inventing an amount.
 *
 * Two deliberate choices:
 *   - Model-side arithmetic is banned for the k/rb/jt suffixes; the schema takes a plain number and
 *     the prompt spells out the multipliers, because a model that "helpfully" rounds your rupiah is
 *     worse than one that fails loudly.
 *   - `items` is an ARRAY. One message is often two purchases, and splitting them client-side with
 *     a regex was the first thing that broke in testing.
 *
 * Structured-output idiom (schema + responseMimeType + retry) is the same one ai.mjs uses in the
 * pioNox stack — see geminiGenerateJson there.
 */
import { GoogleGenAI, Type } from "@google/genai";
import { log } from "../lib/log.mjs";

const MODEL = process.env.SPEND_MODEL || "gemini-2.5-flash";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fixed, small category list. Fixed because free-text categories turn a spending sheet into
 * confetti within a month ("food", "Food", "makan", "eating out"). Edit this list to taste — the
 * prompt and the schema both read from it, so one edit is enough.
 */
export const CATEGORIES = [
  "Food & Drink",
  "Groceries",
  "Transport",
  "Housing & Bills",
  "Health",
  "Shopping",
  "Entertainment",
  "Travel",
  "Work & Tools",
  "Fees & Charges",
  "Gifts & Giving",
  "Other",
];

const schema = {
  type: Type.OBJECT,
  properties: {
    isExpense: {
      type: Type.BOOLEAN,
      description: "True only if the message records money the person SPENT. False for questions, chit-chat, income, or anything ambiguous.",
    },
    items: {
      type: Type.ARRAY,
      description: "One entry per distinct purchase in the message. Empty when isExpense is false.",
      items: {
        type: Type.OBJECT,
        properties: {
          amount: { type: Type.NUMBER, description: "The full amount as a plain number. 25k → 25000. Never round, never abbreviate." },
          currency: { type: Type.STRING, description: "ISO code. Default to the DEFAULT CURRENCY below unless another is clearly named ($, USD, SGD…)." },
          category: { type: Type.STRING, enum: CATEGORIES, description: "Best fit from the list. Use Other only when nothing fits." },
          merchant: { type: Type.STRING, nullable: true, description: "Where the money went, if named (Grab, Indomaret, a warung's name). Null if not stated." },
          note: { type: Type.STRING, nullable: true, description: "A few words on what it was, when that isn't obvious from merchant alone." },
          method: { type: Type.STRING, nullable: true, description: "Payment method if stated: cash, gopay, ovo, dana, qris, card, transfer. Null otherwise." },
          date: { type: Type.STRING, description: "Absolute date YYYY-MM-DD. Resolve 'kemarin'/'yesterday'/'last friday' against TODAY below. Default to TODAY when no date is mentioned." },
        },
        required: ["amount", "currency", "category", "date"],
      },
    },
    question: {
      type: Type.STRING,
      nullable: true,
      description: "When isExpense is false, or an amount is genuinely missing, ONE short question to ask back. Match the language the person used. Null when the parse is clean.",
    },
  },
  required: ["isExpense", "items"],
};

function systemInstruction({ today, currency, timezone }) {
  return `You turn a person's casual message into structured expense records for their personal
spending sheet. You are not a chatbot: you extract, you do not converse.

TODAY is ${today} (timezone ${timezone}). DEFAULT CURRENCY is ${currency}.

Amount shorthand (Indonesian + English), applied EXACTLY:
  k / rb / ribu  = thousand      → "25k", "25rb" = 25000
  jt / juta      = million       → "1.5jt" = 1500000
  m / mil        = million when the currency is IDR
A bare number is that number: "nasi goreng 25000" = 25000. Never round. Never guess an amount that
was not stated — if there is no number, set isExpense false and ask for it.

Rules:
- Multiple purchases in one message → one entry each ("kopi 25k, bensin 50k" = two entries).
- The person writes in Indonesian, English, or a mix. Understand all of it; ask questions back in
  whichever language they used.
- Income, transfers to savings, questions ("berapa total bulan ini?"), and small talk are NOT
  expenses. Set isExpense false and leave items empty.
- Never invent a merchant. If they didn't name one, merchant is null.
- Prefer a specific category over Other, but do not stretch: a plane ticket is Travel, a taxi to
  work is Transport.`;
}

/** One Gemini call, retried on transient failures (mirrors ai.mjs's withRetry posture). */
async function generate(system, text) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text }] }],
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0, // extraction, not creativity
        },
      });
      return JSON.parse(resp.text ?? "{}");
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(700 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Today's date in a given IANA timezone, as YYYY-MM-DD (the sheet's date format). */
export function todayIn(timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Parse one message into `{ items, question }`. `items` are ready to hand straight to appendSpend.
 * Throws only if Gemini is unreachable after retries — a message it simply doesn't understand comes
 * back as an empty `items` plus a `question`.
 */
export async function parseExpense(message, {
  currency = process.env.SPEND_CURRENCY || "IDR",
  timezone = process.env.SPEND_TZ || "Asia/Jakarta",
} = {}) {
  const today = todayIn(timezone);
  const out = await generate(systemInstruction({ today, currency, timezone }), message);

  const items = (out.isExpense ? out.items ?? [] : [])
    // A zero or negative amount means the model failed to find one; don't write a junk row.
    .filter((it) => Number.isFinite(it?.amount) && it.amount > 0)
    .map((it) => ({
      amount: it.amount,
      currency: (it.currency || currency).toUpperCase(),
      category: CATEGORIES.includes(it.category) ? it.category : "Other",
      merchant: it.merchant || "",
      note: it.note || "",
      method: (it.method || "").toLowerCase(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(it.date || "") ? it.date : today,
      raw: message,
    }));

  if (!items.length) {
    log.debug("parse_no_items", { msg: message.slice(0, 80) });
    return { items: [], question: out.question || null };
  }
  return { items, question: null };
}
