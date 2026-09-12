/**
 * Structured logging + crash handling (#11 production hardening).
 *
 * One logger, two shapes:
 *   - DEV (default): readable single lines, e.g. `· inbound | bid=salon-melati from=628…`.
 *   - PROD (`LOG_JSON=1` or NODE_ENV=production): one JSON object per line, so a log aggregator
 *     (or `jq`) can filter/alert on `event`, `bid`, `level`, etc.
 *
 * Every record carries a timestamp, a level, a short machine-readable `event`, and arbitrary
 * fields. A `msg` field is treated as the human sentence. Errors go to stderr.
 *
 * `installCrashHandlers()` catches the two failure modes that otherwise kill the process silently
 * (uncaught exceptions, unhandled promise rejections), logs them structurally, and hands them to
 * an optional `alert` callback — the seam for owner/ops alerting once a channel exists (ROADMAP #6,
 * currently parked on pioNox's own email).
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const THRESHOLD = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const JSON_MODE = process.env.LOG_JSON === "1" || process.env.NODE_ENV === "production";
const TAGS = { error: "✗", warn: "⚠", info: "·", debug: "…" };

function emit(level, event, fields = {}) {
  if (LEVELS[level] > THRESHOLD) return;
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  if (JSON_MODE) {
    sink(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }));
    return;
  }
  const { msg, ...rest } = fields;
  const extra = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ");
  sink(`${TAGS[level]} ${event}${msg ? " " + msg : ""}${extra ? " | " + extra : ""}`);
}

export const log = {
  error: (event, fields) => emit("error", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  info: (event, fields) => emit("info", event, fields),
  debug: (event, fields) => emit("debug", event, fields),
};

/**
 * Install last-resort handlers for crashes. We log + alert but DO NOT exit: this is a single
 * webhook server with no supervisor to restart it, so staying up (degraded) beats going dark on
 * one stray error. If we later run under a process manager, switch to log-then-exit so it restarts.
 */
export function installCrashHandlers(alert = null) {
  const handle = (kind) => (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error(kind, { msg: err.message, stack: err.stack });
    try { alert?.(err, { kind }); } catch { /* never let alerting throw from a crash handler */ }
  };
  process.on("uncaughtException", handle("uncaught_exception"));
  process.on("unhandledRejection", handle("unhandled_rejection"));
}
