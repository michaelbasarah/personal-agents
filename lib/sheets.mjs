/**
 * The spending ledger's only door to Google Sheets.
 *
 * Same shape as the pioNox swipe/GTM sheet helpers (Services/ai-employees/app/sheets.mjs): raw REST
 * over `fetch` with a service-account bearer token, no `googleapis` dependency. What's new here is
 * that this sheet is READ and MUTATED too, not just appended to — `!today` / `!month` need the rows
 * back, and `!undo` needs to delete one. So we also resolve the tab's numeric `sheetId` (the gid a
 * batchUpdate needs, which is NOT the A1 tab name) and cache it for the process.
 *
 * Header (fixed — do not reorder without updating COLS and appendSpend):
 *
 *   Date | Amount | Currency | Category | Merchant | Note | Method | Raw Message | Logged At
 *
 * The header is written automatically on the first append to a blank sheet, so setup is just:
 * create a sheet, share it with the service account, put its ID in SPEND_SHEET_ID.
 */
import { getAccessToken } from "./google.mjs";

const API = "https://sheets.googleapis.com/v4/spreadsheets";

export const HEADER = [
  "Date",         // YYYY-MM-DD, resolved in SPEND_TZ ("kemarin" → an actual date)
  "Amount",       // number, no thousands separator — USER_ENTERED so Sheets stores it as a number
  "Currency",     // IDR | USD | …
  "Category",     // one of CATEGORIES (spending/parse.mjs)
  "Merchant",     // where it went, if named
  "Note",         // free text
  "Method",       // cash | gopay | card | transfer | …
  "Raw Message",  // exactly what was typed, so a bad parse is always traceable
  "Logged At",    // ISO timestamp of the write
];

// Column indexes by name, so readers never count commas by hand.
export const COLS = Object.fromEntries(HEADER.map((h, i) => [h, i]));

const sheetDocId = () => {
  const id = process.env.SPEND_SHEET_ID;
  if (!id) throw new Error("SPEND_SHEET_ID is not set — see .env.example");
  return id;
};
// Tab name only (no range): the API resolves "Spending" to that tab's used range.
const tab = () => process.env.SPEND_SHEET_TAB || "Spending";
const range = () => `${tab()}!A:I`;

async function authed(url, init = {}) {
  const token = await getAccessToken();
  const resp = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!resp.ok) throw new Error(`Sheets ${init.method || "GET"} failed (${resp.status}): ${await resp.text()}`);
  return resp.json();
}

/** The tab's numeric gid — batchUpdate addresses rows by that, not by tab name. Cached per process. */
let gidCache = null;
async function sheetGid() {
  if (gidCache !== null) return gidCache;
  const meta = await authed(`${API}/${sheetDocId()}?fields=sheets.properties`);
  const want = tab();
  const found = meta.sheets?.find((s) => s.properties?.title === want);
  if (!found) throw new Error(`No tab named "${want}" in the spending sheet`);
  gidCache = found.properties.sheetId;
  return gidCache;
}

// The header only ever has to be laid down once, so after the first confirmed write we stop paying
// for a read on every single expense.
let headerKnown = false;

/**
 * Append one expense. USER_ENTERED (not RAW) so Amount lands as a real number and Date as a real
 * date — `!month` sums them, and you'll want to pivot them later. The raw message is the only
 * free-text field a "=" could sneak into, so it's neutered with a leading apostrophe.
 */
export async function appendSpend(e) {
  const values = [
    e.date,
    e.amount,
    e.currency,
    e.category,
    e.merchant ?? "",
    e.note ?? "",
    e.method ?? "",
    e.raw ? `'${e.raw}` : "",
    new Date().toISOString(),
  ];

  let rows = [values];
  if (!headerKnown) {
    const existing = await authed(`${API}/${sheetDocId()}/values/${encodeURIComponent(`${tab()}!A1:I1`)}`);
    if (!existing.values?.length) rows = [HEADER, values]; // blank sheet → lay the header down first
    headerKnown = true;
  }

  const res = await authed(
    `${API}/${sheetDocId()}/values/${encodeURIComponent(range())}:append` +
      `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: rows }) },
  );
  // "Spending!A7:I7" → 7. Read the range's END row, not its start: the very first write also carries
  // the header, so the expense is the second of two rows. The caller keeps this for `!undo`.
  const rowNum = Number(res.updates?.updatedRange?.match(/:\D+(\d+)$/)?.[1]) || null;
  return { row: rowNum };
}

/** Every logged expense as an object, oldest first. Header row dropped unless `withHeader`. */
export async function readSpendRows({ withHeader = false } = {}) {
  const data = await authed(`${API}/${sheetDocId()}/values/${encodeURIComponent(range())}`);
  const rows = data.values ?? [];
  if (withHeader) return rows;
  return rows
    .slice(1)
    .filter((r) => r[COLS.Amount] !== undefined && r[COLS.Amount] !== "")
    .map((r, i) => ({
      row: i + 2, // +1 for the header, +1 because sheets are 1-indexed
      date: r[COLS.Date] ?? "",
      amount: Number(String(r[COLS.Amount]).replace(/[^0-9.-]/g, "")) || 0,
      currency: r[COLS.Currency] ?? "IDR",
      category: r[COLS.Category] ?? "",
      merchant: r[COLS.Merchant] ?? "",
      note: r[COLS.Note] ?? "",
      method: r[COLS.Method] ?? "",
    }));
}

/** Delete one row by its 1-indexed sheet row number (what appendSpend handed back). */
export async function deleteRow(rowNum) {
  if (!Number.isInteger(rowNum) || rowNum < 2) throw new Error(`Refusing to delete row ${rowNum}`);
  await authed(`${API}/${sheetDocId()}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: await sheetGid(),
              dimension: "ROWS",
              startIndex: rowNum - 1, // batchUpdate is 0-indexed and end-exclusive
              endIndex: rowNum,
            },
          },
        },
      ],
    }),
  });
}
