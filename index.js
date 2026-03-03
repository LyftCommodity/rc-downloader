// ─────────────────────────────────────────────────────────────────────────────
// RingCentral Recording Downloader
// ─────────────────────────────────────────────────────────────────────────────
//
// Automatically downloads call recordings from RingCentral to ./downloads/
// with rich filenames containing call metadata (timestamp, extension, direction,
// caller/callee numbers, duration, recording type).
//
// FIRST TIME SETUP:
//   1. Copy .env.example to .env and fill in your RC credentials
//   2. Generate an encryption key and add it as TOKEN_ENCRYPTION_KEY:
//        node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   3. node index.js
//   4. Visit http://localhost:PORT/login and complete OAuth in the browser
//   5. Visit http://localhost:PORT/recordings/backfill?days=90 to download history
//
// AFTER FIRST LOGIN the server re-authenticates automatically on restart.
//
// KEY ROUTES:
//   /login                        First-time browser login
//   /recordings/backfill?days=N   Download all recordings from the past N days
//   /recordings/status            Live queue progress and ledger stats
//   /health                       Returns 200 OK or 503 with issue details
//   /webhook/register             Subscribe to real-time RC recording events
//
// NEW RECORDINGS are detected via RC webhook (preferred — requires a public
// HTTPS URL set in WEBHOOK_RECEIVER_URL) or polling (fallback — set
// POLL_INTERVAL_MS). Both can run simultaneously.
//
// See README.md for full setup, configuration options, and deployment guide.
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();

const express       = require("express");
const open          = require("open").default;
const path          = require("path");
const fs            = require("fs/promises");
const fsCb          = require("fs");           // createWriteStream needs the callback API
const crypto        = require("crypto");
const { pipeline }  = require("stream/promises");
const { Readable }  = require("stream");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// Structured logger
//
// Emits newline-delimited JSON so logs can be parsed by any log aggregator
// (Datadog, Loki, CloudWatch, etc.) while still being human-readable with
// `node index.js | jq .`
//
// Usage:
//   log("info",  "download complete", { recordingId, bytes })
//   log("warn",  "rate limit hit",    { url, retryAfter })
//   log("error", "queue failure",     { error: e.message })
// ─────────────────────────────────────────────────────────────────────────────

function log(level, message, context = {}) {
  const entry = {
    ts:      new Date().toISOString(),
    level,
    message,
    ...context,
  };
  const output = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(output + "\n");
  } else {
    process.stdout.write(output + "\n");
  }
}

// ── Env vars ──────────────────────────────────────────────────────────────────
const {
  RC_SERVER_URL,
  RC_CLIENT_ID,
  RC_CLIENT_SECRET,
  RC_REDIRECT_URI,
  WEBHOOK_RECEIVER_URL,
  WEBHOOK_VALIDATION_TOKEN = "rc-recording-hook",
  TOKEN_ENCRYPTION_KEY,
  POLL_INTERVAL_MS = "300000",
  // Minimum lookback window for polling, in ms. Polling always queries at least
  // this far back regardless of ledger state, so late-finalized recordings and
  // any calls missed by the webhook (recording not ready within the 6s window)
  // are still caught. Default: 24 hours.
  POLL_LOOKBACK_MS = "86400000",
  DOWNLOADS_DIR,
} = process.env;

if (!RC_SERVER_URL || !RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_REDIRECT_URI) {
  throw new Error("Missing required RC env vars. Check .env");
}

// ── TOKEN_ENCRYPTION_KEY early validation ─────────────────────────────────────
// Validate at startup so a misconfigured key fails loudly rather than silently
// falling back to no persistence deep inside a download loop.
let ENCRYPTION_ENABLED = false;
if (TOKEN_ENCRYPTION_KEY) {
  if (!/^[0-9a-fA-F]{64}$/.test(TOKEN_ENCRYPTION_KEY)) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).\n" +
      "Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  ENCRYPTION_ENABLED = true;
} else {
  log("warn", "TOKEN_ENCRYPTION_KEY not set — token will NOT persist across restarts", {
      hint: "Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    });
}

const BASE    = RC_SERVER_URL.replace(/\/+$/, "").replace(/\/restapi.*$/, "");
const POLL_MS       = parseInt(POLL_INTERVAL_MS, 10) || 0;
const POLL_LOOKBACK = parseInt(POLL_LOOKBACK_MS,  10) || 24 * 60 * 60 * 1000;

// ── File paths ────────────────────────────────────────────────────────────────
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(process.cwd(), "downloads");
const LEDGER_PATH   = path.join(process.cwd(), "ledger.json");
const WEBHOOK_STORE = path.join(process.cwd(), "webhook.json");
const TOKEN_PATH    = path.join(process.cwd(), "token.enc");

// ── File permission constants ─────────────────────────────────────────────────
// 0o600 = owner read/write only. Applied to token.enc and ledger.json since
// they contain credentials and PII (phone numbers, call metadata) respectively.
// 0o700 = owner read/write/execute only. Applied to the downloads directory
// since it contains actual voice recordings of conversations.
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR  = 0o700;

async function writePrivateFile(filePath, content) {
  // Atomic write: write to a temp file, fsync, then rename over the target.
  // rename() is atomic on Linux/macOS — readers always see either the complete
  // old file or the complete new file, never a partial write.
  // fsync before rename ensures data is on disk before the name swap, so a
  // power loss between the two syscalls doesn't leave a zero-byte file.
  const tmp = filePath + ".tmp";
  const fh  = await fs.open(tmp, "w", PRIVATE_FILE);
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  // chmod the tmp file before the rename so the final file is never briefly
  // world-readable, even for a nanosecond.
  await fs.chmod(tmp, PRIVATE_FILE);
  try {
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token encryption (AES-256-GCM, random IV per write)
// ─────────────────────────────────────────────────────────────────────────────

function encryptToken(obj) {
  // ENCRYPTION_ENABLED already guarantees the key is valid hex + correct length
  const key    = Buffer.from(TOKEN_ENCRYPTION_KEY, "hex");
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc    = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(":");
}

function decryptToken(str) {
  if (!str) return null;
  // Let errors propagate to the caller — silent swallowing here means a
  // misconfigured key looks identical to "no token file yet", which is confusing.
  const key           = Buffer.from(TOKEN_ENCRYPTION_KEY, "hex");
  const [ivH, tagH, encH] = str.split(":");
  if (!ivH || !tagH || !encH) throw new Error("token.enc is malformed — delete it and re-login");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivH, "hex"));
  decipher.setAuthTag(Buffer.from(tagH, "hex"));
  return JSON.parse(decipher.update(Buffer.from(encH, "hex")) + decipher.final("utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Token management
// ─────────────────────────────────────────────────────────────────────────────

let token = null;

async function loadToken() {
  if (!ENCRYPTION_ENABLED) return;
  try {
    const raw = (await fs.readFile(TOKEN_PATH, "utf8")).trim();
    const obj = decryptToken(raw);
    if (obj?.accessToken) {
      token = obj;
      log("info", "loaded persisted token", { expiresAt: new Date(token.expiresAt).toISOString() });
    }
  } catch (e) {
    // Distinguish "file doesn't exist yet" from a real decryption failure
    if (e.code !== "ENOENT") {
      log("error", "could not decrypt token.enc — delete it and re-login if the key has changed", { error: e.message });
    }
  }
}

async function persistToken() {
  if (!ENCRYPTION_ENABLED || !token) return;
  await writePrivateFile(TOKEN_PATH, encryptToken(token));
}

function isTokenValid() {
  return token?.accessToken && Date.now() < token.expiresAt - 60_000;
}

async function getValidAccessToken() {
  if (isTokenValid()) return token.accessToken;
  if (!token?.refreshToken) throw new Error("Not authenticated — visit /login");

  // Acquire the refresh lock so concurrent callers don't each issue their own
  // refresh request. The second caller will re-check isTokenValid() after the
  // first finishes and return the already-refreshed token without another request.
  let releaseRefreshLock;
  const nextRefreshLock    = new Promise((resolve) => { releaseRefreshLock = resolve; });
  const waitForRefreshPrev = tokenRefreshLock;
  tokenRefreshLock         = nextRefreshLock;
  await waitForRefreshPrev;

  try {
    // Re-check validity — a concurrent caller may have already refreshed by now
    if (isTokenValid()) return token.accessToken;

    log("info", "refreshing access token");
    const basic = Buffer.from(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`).toString("base64");
    const resp  = await fetch(`${BASE}/restapi/oauth/token`, {
      method:  "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      token = null;
      await fs.unlink(TOKEN_PATH).catch(() => {});
      throw new Error(`Token refresh failed (${resp.status}) — re-login required at /login`);
    }

    const json = JSON.parse(text);
    token = {
      accessToken:  json.access_token,
      refreshToken: json.refresh_token || token.refreshToken,
      expiresAt:    Date.now() + json.expires_in * 1000,
    };
    await persistToken();
    return token.accessToken;
  } finally {
    releaseRefreshLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth state parameter (CSRF protection)
//
// Each /login request generates a random state token stored here with a 10
// minute TTL. /oauth/callback validates it before accepting any auth code.
// This prevents an attacker from tricking the server into consuming a
// code they control (CSRF / auth code injection).
// ─────────────────────────────────────────────────────────────────────────────

const pendingStates = new Map(); // state → expiresAt (ms)
const STATE_TTL_MS  = 10 * 60 * 1000; // 10 minutes

function createState() {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state) {
  if (!state) return false;
  const expiresAt = pendingStates.get(state);
  if (!expiresAt) return false;
  pendingStates.delete(state); // single-use
  return Date.now() < expiresAt;
}

// Periodically clean up any states that were never consumed (e.g. user abandoned login)
setInterval(() => {
  const now = Date.now();
  for (const [state, expiresAt] of pendingStates) {
    if (now > expiresAt) pendingStates.delete(state);
  }
}, STATE_TTL_MS);

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────

let ledger = {};

async function loadLedger() {
  try {
    ledger = JSON.parse(await fs.readFile(LEDGER_PATH, "utf8"));
    log("info", "ledger loaded", { count: Object.keys(ledger).length });
  } catch (e) {
    if (e.code === "ENOENT") {
      // Normal first run — no ledger file yet
      ledger = {};
      return;
    }
    // Anything else (JSON parse error, permission denied, truncated file) is
    // a real problem. Starting with an empty ledger would cause every already-
    // downloaded recording to be re-fetched and overwrite the existing files.
    // Fail loudly so the operator can inspect and recover ledger.json manually.
    throw new Error(`Failed to load ledger.json: ${e.message} — fix or delete the file and restart`);
  }
}

async function saveLedger() {
  // ledger.json contains PII (phone numbers, timestamps) — restrict permissions
  await writePrivateFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function isDownloaded(recordingId) { return !!ledger[recordingId]; }

async function markDownloaded(recordingId, entry) {
  ledger[recordingId] = { ...entry, downloadedAt: new Date().toISOString() };
  await saveLedger();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit-aware HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

const rateLimitState = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Async mutex — ensures only one RC API call is in-flight at a time.
// Without this a webhook firing mid-backfill could produce two concurrent
// rcFetch calls and defeat the per-request pacing.
let rcFetchLock = Promise.resolve();

// Separate mutex for token refresh. Prevents two concurrent callers from both
// seeing an expired token and both issuing a refresh request simultaneously.
// Without this, the second refresh may invalidate the first's new access token.
let tokenRefreshLock = Promise.resolve();

// Fixed fallback delay used when RC omits RL headers (can happen on some
// error responses). Avoids the previous bug where missing headers defaulted
// remaining=1/window=60, causing an accidental 60s stall.
const FALLBACK_DELAY_MS = 500;

function parseRLHeaders(headers) {
  const group    = headers.get("x-rate-limit-group");
  const remaining = headers.get("x-rate-limit-remaining");
  const window_  = headers.get("x-rate-limit-window");
  return {
    group:      group      ?? null,
    remaining:  remaining  !== null ? parseInt(remaining, 10) : null,
    window:     window_    !== null ? parseInt(window_,   10) : null,
    hasHeaders: group !== null && remaining !== null && window_ !== null,
  };
}

async function rcFetch(url, options = {}, maxRetries = 4) {
  // Acquire the lock — wait for any in-flight rcFetch to finish first
  let releaseLock;
  const nextLock    = new Promise((resolve) => { releaseLock = resolve; });
  const waitForPrev = rcFetchLock;
  rcFetchLock       = nextLock;
  await waitForPrev;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const resp = await fetch(url, options);

      if (resp.status === 429) {
        const wait = parseInt(resp.headers.get("retry-after") || "60", 10);
        log("warn", "rate limit 429", { waitSecs: wait, attempt: attempt + 1, maxRetries });
        await sleep(wait * 1000);
        continue;
      }

      const rl = parseRLHeaders(resp.headers);

      if (rl.hasHeaders) {
        rateLimitState[rl.group] = { remaining: rl.remaining, window: rl.window };
        // Spread remaining budget evenly across the current window.
        // remaining <= 1 means we are at the limit — wait for window reset.
        const delayMs = rl.remaining <= 1
          ? rl.window * 1000
          : Math.max(250, Math.floor((rl.window * 1000) / rl.remaining));
        await sleep(delayMs);
      } else {
        // RC omitted RL headers — use a small fixed delay rather than
        // computing from null values (which previously caused a 60s stall).
        log("warn", "no rate-limit headers", { url, fallbackMs: FALLBACK_DELAY_MS });
        await sleep(FALLBACK_DELAY_MS);
      }

      return resp;
    }
    throw new Error(`[rcFetch] gave up after ${maxRetries} retries — ${url}`);
  } finally {
    releaseLock(); // always release, even on throw
  }
}

async function rcGetJson(url) {
  const at   = await getValidAccessToken();
  const resp = await rcFetch(url, { headers: { Authorization: `Bearer ${at}` } });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`RC GET ${resp.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function rcGetAllPages(firstUrl) {
  let records = [], url = firstUrl;
  while (url) {
    const data = await rcGetJson(url);
    if (Array.isArray(data.records)) records = records.concat(data.records);
    url = data.navigation?.nextPage?.uri || null;
    if (url) log("info", "pagination", { recordsFetchedSoFar: records.length });
  }
  return records;
}

async function downloadMedia(contentUri) {
  const at   = await getValidAccessToken();
  let resp   = await rcFetch(contentUri, {
    method: "GET", redirect: "manual",
    headers: { Authorization: `Bearer ${at}`, Accept: "audio/mpeg,audio/wav,*/*" },
  });
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("location");
    if (loc) {
      log("info", "media redirect", { location: loc.slice(0, 80) });
      resp = await fetch(loc, { headers: { Accept: "audio/mpeg,audio/wav,*/*" } });
    }
  }
  return resp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filename helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatIsoForFilename(iso) {
  if (!iso) return "timeUnknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "timeUnknown"
    : d.toISOString().replace("T", "_").replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function pickLabel(endpoint) {
  if (!endpoint) return "unknown";
  return endpoint.phoneNumber || endpoint.extensionNumber || endpoint.name || endpoint.url || "unknown";
}

function sanitize(s, maxLen = 60) {
  return String(s).trim()
    .replace(/\+/g, "")
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, maxLen);
}

function formatDuration(seconds) {
  if (seconds == null) return "durUnknown";
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}m${String(seconds % 60).padStart(2, "0")}s`;
}

function getExtensionLabel(record) {
  const ext = record.extension?.extensionNumber || record.extension?.id
    || record.from?.extensionNumber || record.to?.extensionNumber;
  return ext ? `ext${sanitize(ext)}` : "extUnknown";
}

function detectFileExt(contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("wav"))                        return "wav";
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  return "bin";
}

function buildFilename(record, recordingId, contentType) {
  return [
    formatIsoForFilename(record.startTime),
    getExtensionLabel(record),
    sanitize((record.direction || "unknown").toLowerCase()),
    `from_${sanitize(pickLabel(record.from))}`,
    `to_${sanitize(pickLabel(record.to))}`,
    `dur_${formatDuration(record.duration)}`,
    sanitize((record.recording?.type || "unknown").toLowerCase()),
    `rec_${sanitize(recordingId || "recUnknown")}`,
  ].join("_") + "." + detectFileExt(contentType);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core download
// ─────────────────────────────────────────────────────────────────────────────

async function downloadRecording(record) {
  const rec         = record.recording;
  const recordingId = rec?.id;

  if (!rec?.contentUri || !recordingId) {
    return { ok: false, error: "No recording contentUri on record" };
  }
  if (isDownloaded(recordingId)) {
    return { recordingId, ok: true, skipped: true, filePath: ledger[recordingId].filePath };
  }

  log("info", "download starting", { recordingId, callId: record.id });
  const mediaResp = await downloadMedia(rec.contentUri);

  if (!mediaResp.ok) {
    const err = await mediaResp.text();
    log("error", "download HTTP error", { recordingId, status: mediaResp.status });
    return { recordingId, ok: false, status: mediaResp.status, error: err };
  }

  const contentType = mediaResp.headers.get("content-type") || "";

  // Guard: if RC returns a non-audio content-type with a 200 (e.g. a JSON error
  // envelope from a gateway, or an HTML error page), treat it as a failure and
  // read the body as text for the error message. Writing it to disk and marking
  // it downloaded would make it unretryable.
  const ct = contentType.toLowerCase();
  if (ct.includes("application/json") || ct.includes("text/html") || ct.includes("text/plain")) {
    const body = await mediaResp.text();
    log("error", "download got non-audio content-type", { recordingId, contentType, body: body.slice(0, 200) });
    return { recordingId, ok: false, error: `Unexpected content-type: ${contentType}`, body: body.slice(0, 200) };
  }

  // Guard: a null body means the response arrived with no body stream at all.
  // This shouldn't happen on a 200 but is possible on some proxies/gateways.
  if (!mediaResp.body) {
    log("error", "download response has no body", { recordingId });
    return { recordingId, ok: false, error: "Response body is null" };
  }

  const filename = buildFilename(record, recordingId, contentType);
  const filePath = path.join(DOWNLOADS_DIR, filename);
  const tmpPath  = filePath + ".tmp";

  // Stream the response body directly to a temp file rather than buffering
  // the entire recording in memory. Large files (long calls, high quality)
  // would otherwise spike the process heap for the full duration of the write.
  //
  // We write to a .tmp file first and rename on completion, consistent with
  // our atomic-write pattern elsewhere. This means the AI file watcher never
  // sees a partial file appear at the final path.
  //
  // Readable.fromWeb() bridges the WHATWG ReadableStream (fetch API) to a
  // Node.js Readable stream that pipeline() can consume.
  const writeStream = fsCb.createWriteStream(tmpPath, { mode: PRIVATE_FILE });
  try {
    await pipeline(Readable.fromWeb(mediaResp.body), writeStream);
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    log("error", "download stream failed", { recordingId, error: e.message });
    return { recordingId, ok: false, error: `Stream error: ${e.message}` };
  }

  // Rename into place atomically. On failure (disk full, permissions), clean
  // up the .tmp so it doesn't accumulate silently.
  try {
    await fs.rename(tmpPath, filePath);
  } catch (e) {
    await fs.unlink(tmpPath).catch(() => {});
    log("error", "download rename failed", { recordingId, tmpPath, filePath, error: e.message });
    return { recordingId, ok: false, error: `Rename error: ${e.message}` };
  }

  const { size: bytes } = await fs.stat(filePath);

  const entry = {
    filePath,
    callId:    record.id,
    startTime: record.startTime,
    duration:  record.duration,
    direction: record.direction,
    from:      pickLabel(record.from),
    to:        pickLabel(record.to),
    recType:   rec.type,
    bytes,
  };
  await markDownloaded(recordingId, entry);
  opState.lastDownloadAt = new Date().toISOString();
  opState.lastDownloadId = recordingId;
  log("info", "download saved", { recordingId, filename, bytes });
  return { recordingId, ok: true, skipped: false, ...entry };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serial download queue
// ─────────────────────────────────────────────────────────────────────────────

const queue = {
  items:           [],
  running:         false,
  total:           0,
  done:            0,
  errors:          0,
  // Holds the Promise of the currently-executing downloadRecording call so
  // graceful shutdown can await it before exiting.
  currentDownload: null,
};

// Set to true by the SIGTERM/SIGINT handler. Prevents new items being
// dequeued so the current download can finish and we can exit cleanly.
let shuttingDown = false;

async function runQueue() {
  if (queue.running) return;
  queue.running = true;
  log("info", "queue started", { pending: queue.items.length });
  while (queue.items.length > 0 && !shuttingDown) {
    const record = queue.items.shift();
    try {
      queue.currentDownload = downloadRecording(record);
      const r = await queue.currentDownload;
      if (!r.ok) queue.errors++;
    } catch (e) {
      log("error", "queue item failed", { error: e.message });
      queue.errors++;
    } finally {
      queue.currentDownload = null;
    }
    queue.done++;
  }
  queue.running = false;
  log("info", "queue finished", { done: queue.done, errors: queue.errors });
}

function enqueueRecords(records) {
  if (shuttingDown) return 0;
  const novel = records.filter((r) => r.recording?.contentUri && !isDownloaded(r.recording?.id));
  queue.items.push(...novel);
  queue.total += novel.length;
  if (!queue.running) runQueue();
  return novel.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Operational state — tracked for /health endpoint
// ─────────────────────────────────────────────────────────────────────────────

const opState = {
  lastPollAt:          null,  // ISO string of most recent poll attempt
  lastPollError:       null,  // error message if last poll failed, else null
  lastDownloadAt:      null,  // ISO string of most recent successful download
  lastDownloadId:      null,  // recordingId of most recent successful download
};

// ─────────────────────────────────────────────────────────────────────────────
// Webhook subscription
// ─────────────────────────────────────────────────────────────────────────────

let webhookSub = null;

async function loadWebhookStore() {
  try {
    webhookSub = JSON.parse(await fs.readFile(WEBHOOK_STORE, "utf8"));
    log("info", "webhook subscription loaded", { id: webhookSub.id });
  } catch { webhookSub = null; }
}

async function registerWebhook() {
  if (!WEBHOOK_RECEIVER_URL) throw new Error("WEBHOOK_RECEIVER_URL not set in .env");
  const at = await getValidAccessToken();
  const resp = await fetch(`${BASE}/restapi/v1.0/subscription`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      eventFilters: [
        "/restapi/v1.0/account/~/telephony/sessions",
        "/restapi/v1.0/subscription/~?threshold=120&interval=60",
      ],
      deliveryMode: {
        transportType:     "WebHook",
        address:           `${WEBHOOK_RECEIVER_URL.replace(/\/+$/, "")}/webhook/event`,
        verificationToken: WEBHOOK_VALIDATION_TOKEN,
      },
      expiresIn: 3600,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Webhook registration failed: ${resp.status} ${text}`);
  const json = JSON.parse(text);
  webhookSub = { id: json.id, expiresAt: json.expirationTime };
  await writePrivateFile(WEBHOOK_STORE, JSON.stringify(webhookSub, null, 2));
  log("info", "webhook registered", { id: json.id, expiresAt: json.expirationTime });
  return webhookSub;
}

async function renewWebhook() {
  if (!webhookSub?.id) return;
  const at   = await getValidAccessToken();
  const resp = await fetch(`${BASE}/restapi/v1.0/subscription/${webhookSub.id}/renew`, {
    method: "POST", headers: { Authorization: `Bearer ${at}` },
  });
  if (!resp.ok) {
    log("warn", "webhook renewal failed — re-registering");
    await registerWebhook();
    return;
  }
  const json = await resp.json();
  webhookSub.expiresAt = json.expirationTime;
  await writePrivateFile(WEBHOOK_STORE, JSON.stringify(webhookSub, null, 2));
  log("info", "webhook renewed", { expiresAt: json.expirationTime });
}

app.post("/webhook/event", async (req, res) => {
  // ── Step 1: Subscription handshake ──────────────────────────────────────────
  // RC sends Validation-Token ONLY on the initial subscription-creation request.
  // We must echo it back in the response header. This is the only time this
  // header appears; we never see it again on real event POSTs.
  const validationToken = req.headers["validation-token"];
  if (validationToken) return res.set("Validation-Token", validationToken).status(200).send("");

  // ── Step 2: Ongoing event verification ──────────────────────────────────────
  // RC includes the developer-set verificationToken in the header of every
  // subsequent event notification. We require it on every real event POST —
  // if it's missing OR wrong, we reject. The previous code only rejected if
  // it was present-but-wrong, which allowed spoofed requests with no header.
  const verifyToken = req.headers["verification-token"];
  if (verifyToken !== WEBHOOK_VALIDATION_TOKEN) {
    log("warn", "webhook rejected — bad or missing verification-token");
    return res.status(401).send("Invalid verification token");
  }

  res.status(200).send("");
  setImmediate(() => handleWebhookEvent(req.body).catch((e) =>
    log("error", "webhook handler uncaught error", { error: e.message })
  ));
});

async function handleWebhookEvent(body) {
  if (!body?.event) return;

  // Assign a correlation ID to every webhook event so all log lines for a
  // single event (session end → call-log query → enqueue) can be grepped together.
  const eventId = crypto.randomUUID();

  if (body.event.includes("/subscription/~")) {
    log("info", "webhook renewal reminder", { eventId });
    await renewWebhook();
    return;
  }
  const sess = body.body;
  if (!sess) return;
  const allDone = Array.isArray(sess.parties) && sess.parties.length > 0 &&
    sess.parties.every((p) => p.status?.code === "Disconnected");
  if (!allDone) return;

  const sessionId = sess.telephonySessionId;
  log("info", "webhook session ended", { eventId, sessionId });

  await sleep(6000);
  try {
    const data   = await rcGetJson(
      `${BASE}/restapi/v1.0/account/~/call-log` +
      `?telephonySessionId=${encodeURIComponent(sessionId)}&recordingType=All`
    );
    const queued = enqueueRecords((data.records || []).filter((r) => r.recording?.contentUri));
    log("info", "webhook recordings queued", { eventId, sessionId, queued });
  } catch (e) {
    log("error", "webhook call-log fetch failed", { eventId, sessionId, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling fallback
// ─────────────────────────────────────────────────────────────────────────────

let pollTimer = null;

async function pollForNewRecordings() {
  opState.lastPollAt = new Date().toISOString();
  try {
    const latest = Object.values(ledger).map((e) => e.startTime).filter(Boolean).sort().at(-1);

    // Floor: always look back at least POLL_LOOKBACK ms from now.
    // This ensures late-finalized recordings and calls missed by the webhook
    // (recording not ready within the 6s post-session delay) are still caught.
    //
    // Ceiling: if the ledger has entries, also go back 120s before the latest
    // known recording to catch anything finalized slightly out of order.
    //
    // We use whichever of the two gives us the earlier (larger) window.
    const floorTs  = Date.now() - POLL_LOOKBACK;
    const latestTs = latest ? new Date(latest).getTime() - 120_000 : 0;
    const since    = new Date(Math.min(floorTs, latestTs)).toISOString();

    log("info", "poll checking", { since });
    const records = await rcGetAllPages(
      `${BASE}/restapi/v1.0/account/~/call-log` +
      `?dateFrom=${encodeURIComponent(since)}&recordingType=All&perPage=100`
    );
    const queued = enqueueRecords(records);
    if (queued > 0) log("info", "poll queued recordings", { queued });
  } catch (e) {
    opState.lastPollError = e.message;
    log("error", "poll failed", { error: e.message });
    return;
  }
  opState.lastPollError = null;
}

function startPolling() {
  if (!POLL_MS || pollTimer) return;
  log("info", "polling started", { intervalSecs: POLL_MS / 1000 });
  pollTimer = setInterval(pollForNewRecordings, POLL_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-start on restart using persisted token
// ─────────────────────────────────────────────────────────────────────────────

async function tryAutoStart() {
  if (!token?.refreshToken) {
    log("info", "auto-start skipped — no persisted token");
    return;
  }
  try {
    await getValidAccessToken();
    if (WEBHOOK_RECEIVER_URL) {
      if (webhookSub?.id) {
        const at   = await getValidAccessToken();
        const resp = await fetch(`${BASE}/restapi/v1.0/subscription/${webhookSub.id}`, {
          headers: { Authorization: `Bearer ${at}` },
        });
        if (!resp.ok) {
          log("info", "auto-start: stored subscription expired — re-registering");
          await registerWebhook();
        } else {
          log("info", "auto-start: webhook subscription still active");
        }
      } else {
        await registerWebhook();
      }
    }
    startPolling();
    log("info", "auto-start complete");
  } catch (e) {
    log("warn", "auto-start failed — manual login required at /login", { error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get("/login", async (_req, res) => {
  const state   = createState();
  const authUrl =
    `${BASE}/restapi/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(RC_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(RC_REDIRECT_URI)}` +
    `&state=${state}`;
  res.send(`Opening browser… or visit: <a href="${authUrl}">${authUrl}</a>`);
  await open(authUrl);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    // Validate state before touching anything else
    const state = String(req.query.state || "");
    if (!consumeState(state)) {
      return res.status(400).send(
        "Invalid or expired state parameter. This request may have been tampered with. " +
        "Please visit <a href='/login'>/login</a> and try again."
      );
    }

    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Missing code");

    const basic = Buffer.from(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`).toString("base64");
    const resp  = await fetch(`${BASE}/restapi/oauth/token`, {
      method:  "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: RC_REDIRECT_URI }),
    });

    const text = await resp.text();
    if (!resp.ok) return res.status(500).send(`Token exchange failed: ${resp.status} ${text}`);

    const json = JSON.parse(text);
    token = {
      accessToken:  json.access_token,
      refreshToken: json.refresh_token,
      expiresAt:    Date.now() + json.expires_in * 1000,
    };

    await persistToken();
    await tryAutoStart();

    res.send(`
      <h2>✅ Authenticated!</h2>
      <p>Token saved to disk — the server will re-authenticate automatically on future restarts.</p>
      <ul>
        <li><a href="/recordings/backfill?days=90">Backfill last 90 days</a></li>
        <li><a href="/recordings/status">Queue / ledger status</a></li>
        <li><a href="/calllog/sample">Inspect raw call log</a></li>
      </ul>
    `);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/webhook/register", async (_req, res) => {
  try   { res.json({ ok: true, subscription: await registerWebhook() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete("/webhook/register", async (_req, res) => {
  if (!webhookSub?.id) return res.json({ ok: true, message: "No active subscription" });
  try {
    const at = await getValidAccessToken();
    await fetch(`${BASE}/restapi/v1.0/subscription/${webhookSub.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${at}` },
    });
    webhookSub = null;
    await fs.unlink(WEBHOOK_STORE).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/recordings/backfill", async (req, res) => {
  try {
    const days  = Math.max(1, parseInt(req.query.days || "30", 10));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const records = await rcGetAllPages(
      `${BASE}/restapi/v1.0/account/~/call-log` +
      `?dateFrom=${encodeURIComponent(since)}&recordingType=All&perPage=100`
    );
    const withRec = records.filter((r) => r.recording?.contentUri);
    res.json({
      ok:            true,
      daysBack:      days,
      totalRecords:  records.length,
      withRecording: withRec.length,
      alreadyHave:   withRec.filter((r) => isDownloaded(r.recording?.id)).length,
      newlyQueued:   enqueueRecords(withRec),
      message:       "Running in background — check /recordings/status",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/recordings/status", (_req, res) => {
  res.json({
    queue:      { running: queue.running, pending: queue.items.length, done: queue.done, errors: queue.errors, total: queue.total },
    ledger:     { totalDownloaded: Object.keys(ledger).length },
    auth:       { authenticated: !!token, tokenPersisted: ENCRYPTION_ENABLED },
    webhook:    webhookSub || "not registered",
    polling:    POLL_MS ? `every ${POLL_MS / 1000}s, lookback ${POLL_LOOKBACK / 3600000}h` : "disabled",
    rateLimits: rateLimitState,
    ops:        opState,
  });
});

// /health — machine-readable liveness + readiness check.
// Returns 200 only when the server is authenticated and operating normally.
// Returns 503 for any condition that means recordings may be getting missed,
// so a process monitor or uptime checker can alert on it.
app.get("/health", (_req, res) => {
  const issues = [];

  if (!token) {
    issues.push("not authenticated — visit /login");
  }

  if (WEBHOOK_RECEIVER_URL && webhookSub) {
    const expiresAt  = new Date(webhookSub.expiresAt).getTime();
    const minsLeft   = Math.floor((expiresAt - Date.now()) / 60_000);
    if (minsLeft < 5) issues.push(`webhook subscription expires in ${minsLeft} minutes`);
  } else if (WEBHOOK_RECEIVER_URL && !webhookSub) {
    issues.push("webhook not registered — visit /webhook/register");
  }

  if (POLL_MS && opState.lastPollError) {
    issues.push(`last poll failed: ${opState.lastPollError}`);
  }

  // Warn if polling is enabled but hasn't fired recently (2× interval + grace)
  if (POLL_MS && opState.lastPollAt) {
    const staleSince = Date.now() - new Date(opState.lastPollAt).getTime();
    if (staleSince > POLL_MS * 2 + 30_000) {
      issues.push(`polling appears stalled — last poll was ${Math.floor(staleSince / 60_000)} minutes ago`);
    }
  }

  const status = issues.length === 0 ? 200 : 503;
  res.status(status).json({
    status:           status === 200 ? "ok" : "degraded",
    issues,
    authenticated:    !!token,
    webhookActive:    !!(WEBHOOK_RECEIVER_URL && webhookSub),
    webhookExpiresAt: webhookSub?.expiresAt || null,
    lastPollAt:       opState.lastPollAt,
    lastDownloadAt:   opState.lastDownloadAt,
    lastDownloadId:   opState.lastDownloadId,
    queuePending:     queue.items.length,
    shuttingDown,
  });
});

app.get("/calllog/sample", async (_req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    res.json(await rcGetJson(
      `${BASE}/restapi/v1.0/account/~/call-log?dateFrom=${encodeURIComponent(since)}&perPage=5`
    ));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
//
// On SIGTERM or SIGINT:
//   1. Stop accepting new queue items (shuttingDown = true)
//   2. Clear the poll interval so no new RC calls are initiated
//   3. Await the current in-flight download (if any) so we never leave a
//      partial audio file on disk that the AI watcher might try to process
//   4. Exit cleanly
//
// The ledger is safe because markDownloaded() uses atomic writes — any
// completed download is already durably recorded before we get here.
// ─────────────────────────────────────────────────────────────────────────────

async function shutdown(signal) {
  log("info", "shutdown initiated", { signal });
  shuttingDown = true;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log("info", "polling stopped");
  }

  if (queue.currentDownload) {
    log("info", "waiting for current download to finish before exiting");
    try {
      await queue.currentDownload;
      log("info", "in-flight download completed cleanly");
    } catch (e) {
      log("warn", "in-flight download failed during shutdown", { error: e.message });
    }
  }

  log("info", "shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  // Create downloads dir with restricted permissions before anything else.
  // mkdir is a no-op if it already exists, but won't retroactively tighten
  // permissions, so we chmod explicitly afterwards.
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  await fs.chmod(DOWNLOADS_DIR, PRIVATE_DIR);

  await loadLedger();
  await loadWebhookStore();
  await loadToken();

  app.listen(PORT, async () => {
    log("info", "server started", { port: PORT });
    console.log(`\n🟢  http://localhost:${PORT}`);
    console.log("─".repeat(50));
    console.log("  /login                         First-time authentication");
    console.log("  /recordings/backfill?days=90   Download all historical recordings");
    console.log("  /recordings/status             Live queue + ledger status");
    console.log("  /health                        Liveness + readiness check");
    console.log("  /calllog/sample                Inspect raw call log");
    console.log("─".repeat(50));
    console.log(`  Token persistence : ${ENCRYPTION_ENABLED ? "✅ enabled" : "❌ disabled — set TOKEN_ENCRYPTION_KEY"}`);
    console.log(`  Webhook           : ${WEBHOOK_RECEIVER_URL || "❌ disabled — set WEBHOOK_RECEIVER_URL"}`);
    console.log(`  Polling           : ${POLL_MS ? `✅ every ${POLL_MS / 1000}s` : "❌ disabled — set POLL_INTERVAL_MS"}`);
    console.log("");
    await tryAutoStart();
  });
}

start().catch((e) => { log("error", "fatal startup error", { error: e.message }); process.exit(1); });
