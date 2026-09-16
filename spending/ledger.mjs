/**
 * The spending ledger: one fixed header, bound to one sheet, built on the generic lib/sheets.mjs.
 *
 * This file exists so `lib/` stays reusable. Everything here is opinionated about *spending* — the
 * column order, the apostrophe on the raw message, treating an empty Amount as "not a row". A second
 * agent writing to a different sheet in the same Drive folder writes its own file like this one and
 * shares the plumbing underneath.
 *
 * Header (fixed — reorder it and you must reorder `toRow` with it):
 *
 *   Date | Amount | Currency | Category | Merchant | Note | Method | Raw Message | Logged At
 *
 * It's written automatically the first time you log an expense into an empty tab, so setup is only:
 * make a sheet, drop it in the shared folder, name the tab.
 */
import { appendRows, readObjects, deleteRow as deleteSheetRow, ensureHeader, escapeCell } from "../lib/sheets.mjs";
import { findSheetId } from "../lib/drive.mjs";

export const HEADER = [
  "Date",         // YYYY-MM-DD, resolved in SPEND_TZ ("kemarin" → an actual date)
  "Amount",       // a real number — USER_ENTERED means you can sum and pivot it without cleanup
  "Currency",     // IDR | USD | …
  "Category",     // one of CATEGORIES (spending/parse.mjs)
  "Merchant",     // where it went, if named
  "Note",         // free text
  "Method",       // cash | gopay | card | transfer | …
  "Raw Message",  // exactly what was typed, so a bad parse is always traceable
  "Logged At",    // ISO timestamp of the write
];

/**
 * Which sheet to write to, resolved once per process.
 *
 * `SPEND_SHEET_ID` wins when it's set. Otherwise, if a Drive folder is shared with the service
 * account, look the sheet up there **by name** — that's the point of the folder: adding an agent
 * shouldn't mean another trip to a console, just a file in a folder.
 */
let resolved = null;
export async function ledgerTarget() {
  if (resolved) return resolved;
  const tab = process.env.SPEND_SHEET_TAB || "Spending";

  if (process.env.SPEND_SHEET_ID) {
    resolved = { sheetId: process.env.SPEND_SHEET_ID, tab };
    return resolved;
  }
  if (process.env.AGENTS_DRIVE_FOLDER_ID) {
    const name = process.env.SPEND_SHEET_NAME || "Spending";
    const sheetId = await findSheetId(name);
    if (!sheetId) throw new Error(`No spreadsheet named "${name}" in the shared Drive folder`);
    resolved = { sheetId, tab };
    return resolved;
  }
  throw new Error("Set SPEND_SHEET_ID, or AGENTS_DRIVE_FOLDER_ID plus a sheet named SPEND_SHEET_NAME");
}

/** One parsed expense → one row, in HEADER order. */
const toRow = (e) => [
  e.date,
  e.amount,
  e.currency,
  e.category,
  e.merchant ?? "",
  e.note ?? "",
  e.method ?? "",
  // The only field the user fully controls, so it's the only one a stray "=" could arrive in.
  escapeCell(e.raw ?? ""),
  new Date().toISOString(),
];

/** Append one expense. Returns the 1-indexed row it landed on, which `!undo` keeps. */
export async function appendSpend(e) {
  const t = await ledgerTarget();
  await ensureHeader(t, HEADER);
  const { lastRow } = await appendRows(t, [toRow(e)]);
  return { row: lastRow };
}

/** Every logged expense, oldest first, typed for the summary commands. */
export async function readSpendRows() {
  const t = await ledgerTarget();
  const rows = await readObjects(t);
  return rows
    .filter((r) => r.Amount !== undefined && r.Amount !== "")
    .map((r) => ({
      row: r.row,
      date: r.Date ?? "",
      // Sheets hands numbers back locale-formatted ("25,000") — strip anything that isn't numeric.
      amount: Number(String(r.Amount).replace(/[^0-9.-]/g, "")) || 0,
      currency: r.Currency || "IDR",
      category: r.Category ?? "",
      merchant: r.Merchant ?? "",
      note: r.Note ?? "",
      method: r.Method ?? "",
    }));
}

/** Delete one ledger row by its sheet row number. */
export async function deleteRow(rowNum) {
  return deleteSheetRow(await ledgerTarget(), rowNum);
}
