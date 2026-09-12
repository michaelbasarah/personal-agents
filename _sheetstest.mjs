/**
 * Sheet round-trip check — proves the service account can actually write to YOUR sheet.
 *
 * This is the step that fails in practice, and it fails silently-looking: the key is valid, the
 * sheet ID is right, and Google still says 403 because nobody shared the sheet with the service
 * account. So: write a marker row, read it back, delete it. Leaves the sheet exactly as it was.
 *
 * Run: node _sheetstest.mjs
 */
import "dotenv/config";
import { appendSpend, readSpendRows, deleteRow } from "./lib/sheets.mjs";

if (!process.env.SPEND_SHEET_ID) {
  console.log("… skipped: no SPEND_SHEET_ID");
  process.exit(0);
}

const marker = `__selftest_${Date.now()}`;
let written = null;

try {
  console.log("· appending a test row…");
  const { row } = await appendSpend({
    date: new Date().toISOString().slice(0, 10),
    amount: 1,
    currency: "IDR",
    category: "Other",
    merchant: marker,
    note: "delete me — written by _sheetstest.mjs",
    method: "",
    raw: marker,
  });
  written = row;
  console.log(`  ✓ wrote row ${row}`);

  console.log("· reading it back…");
  const rows = await readSpendRows();
  const found = rows.find((r) => r.merchant === marker);
  if (!found) throw new Error("row was written but did not come back on read");
  if (found.amount !== 1) throw new Error(`amount round-tripped as ${found.amount}, not 1`);
  console.log(`  ✓ read back row ${found.row}`);

  console.log("· deleting it…");
  await deleteRow(found.row);
  written = null;
  const after = (await readSpendRows()).find((r) => r.merchant === marker);
  if (after) throw new Error("delete did not remove the row");
  console.log("  ✓ deleted");

  console.log("\n✓ sheet round-trip works");
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (written) console.error(`  NOTE: test row ${written} may still be in the sheet — remove it by hand.`);
  if (/403/.test(e.message)) {
    console.error("  → 403 almost always means the sheet isn't shared with the service account's");
    console.error("    client_email as an Editor. Share it, then rerun.");
  }
  process.exit(1);
}
