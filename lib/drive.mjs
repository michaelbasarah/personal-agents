/**
 * Drive discovery, scoped to one folder.
 *
 * The setup that makes this repo reusable: instead of sharing each new spreadsheet with the service
 * account one at a time, you share a single Drive folder with it. Permissions inherit, so every file
 * you drop in there afterwards is reachable with no further setup — a new agent needs a filename,
 * not a console visit.
 *
 * `AGENTS_DRIVE_FOLDER_ID` is that folder (the last path segment of its URL). Everything here is
 * read-only: it finds and lists, it never deletes. Writing still goes through lib/sheets.mjs.
 *
 * Scope note: listing needs Drive, not Sheets. `getAccessToken` caches per scope, so a process doing
 * both holds two tokens and never hands a Drive token to a Sheets call.
 */
import { getAccessToken } from "./google.mjs";

const API = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

const folderId = (override) => {
  const id = override || process.env.AGENTS_DRIVE_FOLDER_ID;
  if (!id) throw new Error("AGENTS_DRIVE_FOLDER_ID is not set — see .env.example");
  return id;
};

async function authed(path, params = {}) {
  const token = await getAccessToken(SCOPE);
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    const body = await resp.text();
    const err = new Error(`Drive GET ${path} failed (${resp.status}): ${body.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/** A single quoted literal for a Drive query — apostrophes in filenames break the `q` grammar. */
const q = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * Everything in the folder, newest-modified first. `mimeType` narrows it (`SHEET_MIME` for
 * spreadsheets only). Pages through the full listing rather than stopping at Drive's default 100.
 */
export async function listFiles({ folder, mimeType, includeTrashed = false } = {}) {
  const clauses = [`${q(folderId(folder))} in parents`];
  if (!includeTrashed) clauses.push("trashed = false");
  if (mimeType) clauses.push(`mimeType = ${q(mimeType)}`);

  const files = [];
  let pageToken;
  do {
    const page = await authed("files", {
      q: clauses.join(" and "),
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink)",
      orderBy: "modifiedTime desc",
      pageSize: 100,
      pageToken,
    });
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

/**
 * Find one file in the folder by exact name. Returns null when absent, so a caller can decide
 * between creating it and failing loudly. Throws when the name is ambiguous — Drive happily allows
 * two files with the same name in one folder, and silently picking either is how an agent starts
 * writing into the wrong ledger.
 */
export async function findFile(name, { folder, mimeType } = {}) {
  const clauses = [`${q(folderId(folder))} in parents`, "trashed = false", `name = ${q(name)}`];
  if (mimeType) clauses.push(`mimeType = ${q(mimeType)}`);
  const { files = [] } = await authed("files", {
    q: clauses.join(" and "),
    fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
    pageSize: 10,
  });
  if (files.length > 1) throw new Error(`Drive: ${files.length} files named "${name}" in that folder — rename one`);
  return files[0] ?? null;
}

/** A spreadsheet's id by name, ready to hand to lib/sheets.mjs as `sheetId`. */
export async function findSheetId(name, opts = {}) {
  const file = await findFile(name, { ...opts, mimeType: SHEET_MIME });
  return file?.id ?? null;
}

/** The folder's own name — the cheapest proof that the share actually landed. */
export async function describeFolder(folder) {
  return authed(`files/${folderId(folder)}`, { fields: "id, name, mimeType, webViewLink" });
}
