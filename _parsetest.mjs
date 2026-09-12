/**
 * Parser tests — the only genuinely risky part of this agent.
 *
 * These hit the real Gemini API (the whole point is that the MODEL reads shorthand correctly; a
 * mocked model would test nothing). Costs a fraction of a cent. Skips cleanly without a key.
 *
 * Run: node _parsetest.mjs
 */
import "dotenv/config";
import { parseExpense, todayIn } from "./spending/parse.mjs";

if (!process.env.GEMINI_API_KEY) {
  console.log("… skipped: no GEMINI_API_KEY");
  process.exit(0);
}

const TZ = "Asia/Jakarta";
const TODAY = todayIn(TZ);
const yesterday = () => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const cases = [
  {
    msg: "kopi 25k",
    expect: (r) => {
      check("one item", r.items.length === 1, `got ${r.items.length}`);
      check("25k → 25000", r.items[0]?.amount === 25000, `got ${r.items[0]?.amount}`);
      check("defaults to IDR", r.items[0]?.currency === "IDR", r.items[0]?.currency);
      check("dated today", r.items[0]?.date === TODAY, r.items[0]?.date);
      check("food category", r.items[0]?.category === "Food & Drink", r.items[0]?.category);
    },
  },
  {
    msg: "grab ke bandara 45rb pake gopay",
    expect: (r) => {
      check("45rb → 45000", r.items[0]?.amount === 45000, `got ${r.items[0]?.amount}`);
      check("transport", r.items[0]?.category === "Transport", r.items[0]?.category);
      check("merchant grab", /grab/i.test(r.items[0]?.merchant || ""), r.items[0]?.merchant);
      check("method gopay", r.items[0]?.method === "gopay", r.items[0]?.method);
    },
  },
  {
    msg: "lunch 60k, parkir 5k",
    expect: (r) => {
      check("splits two purchases", r.items.length === 2, `got ${r.items.length}`);
      check("amounts 60000 + 5000", r.items.map((i) => i.amount).sort((a, b) => a - b).join(",") === "5000,60000",
        r.items.map((i) => i.amount).join(","));
    },
  },
  {
    msg: "kemarin belanja bulanan 1.2jt",
    expect: (r) => {
      check("1.2jt → 1200000", r.items[0]?.amount === 1200000, `got ${r.items[0]?.amount}`);
      check("resolves 'kemarin'", r.items[0]?.date === yesterday(), `got ${r.items[0]?.date}, wanted ${yesterday()}`);
    },
  },
  {
    msg: "berapa total bulan ini?",
    expect: (r) => {
      check("a question is not an expense", r.items.length === 0, `wrote ${r.items.length} rows`);
    },
  },
  {
    msg: "beli nasi goreng tadi",
    expect: (r) => {
      check("no amount → no row", r.items.length === 0, `wrote ${r.items.length} rows`);
      check("asks for the amount", !!r.question, "no question returned");
    },
  },
  {
    msg: "spotify $11.99",
    expect: (r) => {
      check("keeps USD", r.items[0]?.currency === "USD", r.items[0]?.currency);
      check("11.99 intact", r.items[0]?.amount === 11.99, `got ${r.items[0]?.amount}`);
    },
  },
];

console.log(`Parsing ${cases.length} messages (today = ${TODAY})\n`);
for (const c of cases) {
  console.log(`"${c.msg}"`);
  try {
    c.expect(await parseExpense(c.msg, { timezone: TZ, currency: "IDR" }));
  } catch (e) {
    check("did not throw", false, e.message);
  }
  console.log("");
}

console.log(failures ? `✗ ${failures} check(s) failed` : "✓ all checks passed");
process.exit(failures ? 1 : 0);
