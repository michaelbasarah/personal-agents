# personal-agents

My own agents. Separate repo from **pioNox** on purpose — that codebase is client-facing, this one
holds personal data. Nothing here reaches into `~/pioNox`; the shared pieces were copied, not linked.

## What's here

| | |
|---|---|
| `spending/` | Log what you spent in Discord → it lands in a Google Sheet |
| `lib/` | Shared plumbing: Google service-account auth, Sheets I/O, structured logging |

Borrowed from pioNox (`Services/ai-employees/app/`): `google.mjs` verbatim, `log.mjs` verbatim, and
the *shape* of `discord.mjs` (channel routing, per-channel serialization, chunking, restart posture)
and `sheets.mjs` (raw REST, no `googleapis` dependency).

---

## Spending agent

You type this in `#spending`:

```
kopi 25k
grab ke bandara 45rb pake gopay
kemarin belanja bulanan 1.2jt
lunch 60k, parkir 5k
```

It replies:

```
✅ Rp 25,000 — kopi · Food & Drink
✅ Rp 45,000 — Grab · Transport · gopay
```

…and the row is in your sheet. Indonesian, English, or a mix. `k`/`rb` = thousand, `jt` = million.
Multiple purchases in one line get split. If there's no amount, it asks instead of guessing.

**Commands:** `!today` `!week` `!month` `!undo` `!cats` `!help`

**Sheet columns:** Date · Amount · Currency · Category · Merchant · Note · Method · Raw Message ·
Logged At — written automatically on the first entry. `Amount` is a real number and `Date` a real
date, so pivot tables and charts work without cleanup.

### Setup

**1. Discord bot** (in your personal server, not pioNox's)
- [Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token
- On that same page enable **Message Content Intent** — without it the bot sees every message as empty
- OAuth2 → URL Generator → scopes `bot`, permissions `Send Messages` + `Read Message History` → invite it
- Make a `#spending` channel. In Discord: Settings → Advanced → Developer Mode on, then right-click
  the channel and yourself to copy both IDs.

**2. Google Sheet**
- New sheet, rename the first tab to `Spending`. Leave it empty — the header writes itself.
- [GCP console](https://console.cloud.google.com) → enable the **Google Sheets API** → a service
  account → Keys → Add Key → JSON. Save it outside this folder (`~/.config/personal-agents/sa.json`).
- **Share the sheet with the service account's `client_email` as an Editor.** This is the step
  everyone forgets; skipping it produces a 403 that looks like a bad key.

**3. Wire it up**
```bash
cp .env.example .env    # then fill it in
npm install
node _sheetstest.mjs    # writes a row, reads it, deletes it — proves the whole chain
node _parsetest.mjs     # ~7 real Gemini calls, checks the shorthand parsing
npm run spending
```

### Keeping it running

`npm run spending` is fine while you're at the laptop. For always-on, the pioNox posture applies:
the bot logs-then-exits on a fatal so a supervisor restarts it. A `systemd --user` unit or a small
container both work; it's one process with no inbound ports.

### Notes

- `SPEND_USER_IDS` is a hard allowlist and **defaults to nobody**. The bot ignores everyone not on
  it, even inside its own channel.
- The bot only reads its one configured channel. Not DMs, not anywhere else.
- `!undo` only removes the last row and refuses if the sheet changed underneath it — deleting row 12
  renumbers everything below, so it would rather do nothing than delete the wrong line.
- Conversation state is per-process and resets on restart. Each message is a standalone transaction,
  so a restart loses nothing but the `!undo` target.
