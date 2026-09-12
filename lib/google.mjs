/**
 * Google service-account auth — the smallest thing that gets us a Sheets access token.
 *
 * We deliberately DON'T pull in `googleapis` (a huge tree) for one append call. Instead we mint a
 * short-lived OAuth token the manual way: sign a JWT with the service account's private key (RS256,
 * via node's built-in crypto), then exchange it at Google's token endpoint. The token is cached in
 * memory until ~1 min before it expires, so a burst of appends triggers a single exchange.
 *
 * Lifted from the pioNox stack (Services/ai-employees/app/google.mjs) — unchanged logic, personal copy.
 *
 * Setup (one-time):
 *   1. GCP → a service account → create a JSON key.
 *   2. Share the spending Sheet with that account's `client_email` (Editor).
 *   3. Give the app the JSON via env: GOOGLE_SERVICE_ACCOUNT_JSON (the raw JSON, single line) OR
 *      GOOGLE_SERVICE_ACCOUNT_FILE (a path to the .json file).
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const b64url = (input) => Buffer.from(input).toString("base64url");

function loadCreds() {
  const raw =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    (process.env.GOOGLE_SERVICE_ACCOUNT_FILE &&
      readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, "utf8"));
  if (!raw) {
    throw new Error(
      "No Google service-account creds — set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE",
    );
  }
  const creds = JSON.parse(raw);
  if (!creds.client_email || !creds.private_key) {
    throw new Error("Service-account JSON is missing client_email / private_key");
  }
  // When the JSON is squeezed into an env var, the PEM newlines often arrive escaped as literal \n.
  creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  return creds;
}

// Cache is keyed BY SCOPE: a Sheets-scoped token must never be handed to a Calendar call (and vice
// versa) when both run in the same process. Each distinct scope string gets its own cached token.
const cache = new Map(); // scope → { token, exp }

/** A valid bearer token for `scope` (cached until shortly before expiry). */
export async function getAccessToken(scope = "https://www.googleapis.com/auth/spreadsheets") {
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(scope);
  if (hit && now < hit.exp - 60) return hit.token;

  const { client_email, private_key } = loadCreds();
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(private_key);
  const jwt = `${signingInput}.${b64url(signature)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Google token exchange failed (${resp.status}): ${await resp.text()}`);
  }
  const json = await resp.json();
  const token = json.access_token;
  cache.set(scope, { token, exp: now + (json.expires_in ?? 3600) });
  return token;
}
