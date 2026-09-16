/**
 * Setup doctor — runs the whole credential chain in order and names the exact broken link.
 *
 * Wiring this agent means touching four separate consoles (Discord, AI Studio, GCP, Sheets), and
 * every one of them fails in a way that looks like a different one's fault: a missing Message
 * Content intent looks like a dead bot, an unshared sheet looks like a bad service-account key.
 * So each check here is isolated, ordered cheapest-first, and prints the next action rather than
 * a stack trace.
 *
 * Run: npm run doctor
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

let failed = 0;
const pass = (name, detail = "") => console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
const warn = (name, fix) => console.log(`  ! ${name}\n      → ${fix}`);
const fail = (name, fix) => {
  failed++;
  console.log(`  ✗ ${name}\n      → ${fix}`);
};
const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------- 1. env

section("env");
const REQUIRED = {
  DISCORD_TOKEN: "Developer Portal → your app → Bot → Reset Token",
  GEMINI_API_KEY: "aistudio.google.com/apikey → Create API key",
};
for (const [key, fix] of Object.entries(REQUIRED)) {
  if (process.env[key]) pass(key, `${process.env[key].length} chars`);
  else fail(`${key} is empty`, fix);
}

// The ledger can be addressed two ways: a literal sheet id, or a name looked up inside the shared
// Drive folder. Either is fine; neither is not.
if (process.env.SPEND_SHEET_ID) {
  const id = process.env.SPEND_SHEET_ID;
  if (/^https?:/.test(id)) {
    fail("SPEND_SHEET_ID is a full URL, not an id",
         "keep only the part between /d/ and /edit — 44 characters, no slashes");
  } else if (id.length < 30) {
    fail(`SPEND_SHEET_ID looks too short (${id.length} chars)`, "a real sheet id is ~44 characters");
  } else {
    pass("SPEND_SHEET_ID", `${id.length} chars`);
  }
} else if (process.env.AGENTS_DRIVE_FOLDER_ID) {
  pass("SPEND_SHEET_ID empty", `will look up "${process.env.SPEND_SHEET_NAME || "Spending"}" in the Drive folder`);
} else {
  fail("neither SPEND_SHEET_ID nor AGENTS_DRIVE_FOLDER_ID is set",
       "set one: the sheet's id from its URL, or the shared folder's id from drive.google.com/drive/folders/<THIS>");
}
if (process.env.SPEND_USER_IDS?.trim()) {
  const ids = process.env.SPEND_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  pass("SPEND_USER_IDS", `${ids.length} user(s) allowlisted`);
} else {
  // Not fatal to the chain, but the bot would run and silently ignore every message you send it.
  warn("SPEND_USER_IDS is empty — the bot will ignore EVERYONE, including you",
       "Discord → Settings → Advanced → Developer Mode, then right-click yourself → Copy User ID");
}
if (!process.env.SPEND_CHANNEL_ID) {
  warn(`SPEND_CHANNEL_ID is empty — will fall back to a channel named "${process.env.SPEND_CHANNEL_NAME || "spending"}"`,
       "right-click the channel → Copy Channel ID (more reliable than the name)");
}

// ---------------------------------------------------------------- 2. service account

section("google service account");
let clientEmail = null;
try {
  const raw =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    (process.env.GOOGLE_SERVICE_ACCOUNT_FILE && readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, "utf8"));
  if (!raw) throw new Error("neither GOOGLE_SERVICE_ACCOUNT_JSON nor GOOGLE_SERVICE_ACCOUNT_FILE is set");
  const creds = JSON.parse(raw);
  if (!creds.client_email || !creds.private_key) throw new Error("JSON has no client_email / private_key");
  clientEmail = creds.client_email;
  pass("key file readable", clientEmail);
} catch (e) {
  fail(`service-account key: ${e.message}`,
       "GCP → IAM → Service Accounts → Keys → Add Key → JSON, save it to ~/.config/personal-agents/sa.json");
}

// ---------------------------------------------------------------- 3. token exchange

if (clientEmail) {
  section("google token exchange");
  try {
    const { getAccessToken } = await import("./lib/google.mjs");
    const token = await getAccessToken();
    pass("minted an access token", `${token.slice(0, 12)}…`);
  } catch (e) {
    fail(`token exchange failed: ${e.message.slice(0, 160)}`,
         "usually a corrupted private_key (re-download the JSON) or a disabled/deleted service account");
    clientEmail = null; // don't bother with the sheet checks
  }
}

// ---------------------------------------------------------------- 3b. the drive folder

let resolvedSheetId = process.env.SPEND_SHEET_ID || null;
if (clientEmail && process.env.AGENTS_DRIVE_FOLDER_ID) {
  section("google drive folder");
  try {
    const { describeFolder, listFiles, SHEET_MIME } = await import("./lib/drive.mjs");
    const folder = await describeFolder();
    pass("folder reachable", `"${folder.name}"`);

    const sheets = await listFiles({ mimeType: SHEET_MIME });
    if (sheets.length) pass(`${sheets.length} spreadsheet(s) in it`, sheets.map((f) => f.name).join(", "));
    else warn("no spreadsheets in the folder yet", "drag your Spending sheet into it");

    if (!resolvedSheetId) {
      const want = process.env.SPEND_SHEET_NAME || "Spending";
      const hit = sheets.find((f) => f.name === want);
      if (hit) { resolvedSheetId = hit.id; pass(`resolved "${want}" by name`, hit.id); }
      else fail(`no spreadsheet named "${want}" in the folder`,
                `rename it to "${want}", or set SPEND_SHEET_NAME to one of the names above`);
    }
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      fail("the service account can't see that folder",
           `share the FOLDER with ${clientEmail} as an Editor, and check AGENTS_DRIVE_FOLDER_ID`);
    } else if (/Drive API has not been used|accessNotConfigured|SERVICE_DISABLED/.test(e.message)) {
      fail("the Drive API isn't enabled on this GCP project",
           "APIs & Services → Library → Google Drive API → Enable, then wait ~1 min");
    } else {
      fail(`drive check failed: ${e.message.slice(0, 200)}`, "check AGENTS_DRIVE_FOLDER_ID is the folder's id");
    }
  }
}

// ---------------------------------------------------------------- 4. the sheet

if (clientEmail && resolvedSheetId) {
  section("google sheet");
  const tab = process.env.SPEND_SHEET_TAB || "Spending";
  try {
    const { getAccessToken } = await import("./lib/google.mjs");
    const token = await getAccessToken();
    const resp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${resolvedSheetId}?fields=properties.title,sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (resp.status === 403) {
      fail("403 — the service account cannot see the sheet",
           `share it (or the folder it's in) with ${clientEmail} as an EDITOR. This is the step everyone misses.`);
    } else if (resp.status === 404) {
      fail("404 — no sheet with that id", "re-copy SPEND_SHEET_ID from the sheet's URL");
    } else if (!resp.ok) {
      fail(`sheets api returned ${resp.status}`, (await resp.text()).slice(0, 200));
    } else {
      const meta = await resp.json();
      pass("sheet reachable", `"${meta.properties?.title}"`);
      const tabs = (meta.sheets ?? []).map((s) => s.properties?.title);
      if (tabs.includes(tab)) pass(`tab "${tab}" exists`);
      else fail(`no tab named "${tab}" (found: ${tabs.join(", ") || "none"})`,
                `rename the first tab to "${tab}", or set SPEND_SHEET_TAB to one of those`);
    }
  } catch (e) {
    fail(`sheet check threw: ${e.message.slice(0, 160)}`, "network, or the Sheets API isn't enabled on the GCP project");
  }
}

// ---------------------------------------------------------------- 5. gemini

if (process.env.GEMINI_API_KEY) {
  section("gemini");
  const model = process.env.SPEND_MODEL || "gemini-2.5-flash";
  try {
    // A models.get is free and proves both the key and that this project can see the model.
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${process.env.GEMINI_API_KEY}`,
    );
    if (resp.status === 400 || resp.status === 403) {
      fail("api key rejected", "regenerate at aistudio.google.com/apikey — make sure it's on your PERSONAL google account");
    } else if (resp.status === 404) {
      fail(`model "${model}" not available to this key`, "set SPEND_MODEL to a model your key can reach, e.g. gemini-2.5-flash");
    } else if (!resp.ok) {
      fail(`gemini returned ${resp.status}`, (await resp.text()).slice(0, 200));
    } else {
      pass("api key valid", `model ${model} reachable`);
    }
  } catch (e) {
    fail(`gemini check threw: ${e.message.slice(0, 160)}`, "network");
  }
}

// ---------------------------------------------------------------- 6. discord

if (process.env.DISCORD_TOKEN) {
  section("discord");
  const api = "https://discord.com/api/v10";
  const auth = { Authorization: `Bot ${process.env.DISCORD_TOKEN}` };
  try {
    const me = await fetch(`${api}/users/@me`, { headers: auth });
    if (me.status === 401) {
      fail("token rejected (401)", "Developer Portal → Bot → Reset Token, then paste the NEW token (it's shown once)");
    } else if (!me.ok) {
      fail(`discord returned ${me.status}`, (await me.text()).slice(0, 200));
    } else {
      const user = await me.json();
      pass("token valid", `logged in as ${user.username}`);

      // The single most common silent failure: without this intent every message arrives with an
      // empty `content`, so the bot connects, looks healthy, and never responds to anything.
      const app = await fetch(`${api}/applications/@me`, { headers: auth });
      if (app.ok) {
        const flags = (await app.json()).flags ?? 0;
        const MESSAGE_CONTENT = 1 << 18;          // granted
        const MESSAGE_CONTENT_LIMITED = 1 << 19;  // ungated (under 100 servers)
        if (flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)) pass("MESSAGE CONTENT intent enabled");
        else fail("MESSAGE CONTENT intent is OFF — the bot will see every message as empty",
                  "Developer Portal → your app → Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT");
      }

      const guilds = await fetch(`${api}/users/@me/guilds`, { headers: auth });
      if (guilds.ok) {
        const list = await guilds.json();
        if (list.length) pass("in a server", list.map((g) => g.name).join(", "));
        else fail("the bot isn't in any server",
                  "OAuth2 → URL Generator → scopes `bot`, perms `Send Messages` + `Read Message History` → open the URL");
      }

      if (process.env.SPEND_CHANNEL_ID) {
        const ch = await fetch(`${api}/channels/${process.env.SPEND_CHANNEL_ID}`, { headers: auth });
        if (ch.ok) {
          const c = await ch.json();
          pass("channel visible to the bot", `#${c.name}`);
        } else if (ch.status === 403 || ch.status === 404) {
          fail("the bot can't see SPEND_CHANNEL_ID",
               "wrong id, or the channel's permissions hide it from the bot's role");
        }
      }
    }
  } catch (e) {
    fail(`discord check threw: ${e.message.slice(0, 160)}`, "network");
  }
}

// ---------------------------------------------------------------- verdict

console.log();
if (failed) {
  console.log(`✗ ${failed} thing${failed > 1 ? "s" : ""} still to fix. Work top-down — later checks depend on earlier ones.`);
  process.exit(1);
}
console.log("✓ every credential checks out. Next: node _sheetstest.mjs, then npm run spending");
