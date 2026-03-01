# rc-recorder

A production-ready Node.js service that automatically downloads call recordings from RingCentral and saves them to a local folder with rich, descriptive filenames. Designed to feed a local AI pipeline that watches the downloads folder for transcription and summarisation.

## How it works

```
RingCentral API
      │
      ├─ Webhook (real-time, preferred)
      │    RC posts an event when a call session ends →
      │    server queries call log → downloads recording
      │
      └─ Polling (fallback, or alongside webhooks)
           Checks for new recordings on a configurable interval
           Always looks back at least 24 hours to catch
           late-finalized recordings

Downloads land in ./downloads/ with filenames like:
2026-01-28_14-30-00Z_ext102_inbound_from_15551234567_to_102_dur_04m32s_automatic_rec_8675309.mp3
```

The filename encodes everything your downstream AI needs to make assumptions before processing: timestamp, extension number, call direction, caller and callee numbers, duration, recording type, and recording ID.

---

## Requirements

- **Node.js 18+** — required for `stream.Readable.fromWeb()`
- A **RingCentral account** with call recording enabled
- A **RingCentral app** registered at [developers.ringcentral.com](https://developers.ringcentral.com)

---

## Installation

```bash
git clone <your-repo>
cd rc-recorder
npm install
cp .env.example .env
```

Edit `.env` — see [Configuration](#configuration) below.

---

## First-time setup

### 1. Create a RingCentral app

In the [RC Developer Console](https://developers.ringcentral.com):

1. Create a new app — type: **Server-side web app**
2. Add these OAuth permissions:
   - `Read Call Log`
   - `Read Call Recording Content`
   - `Webhook Subscriptions` (needed for real-time events)
3. Set the OAuth redirect URI to: `http://localhost:3000/oauth/callback`
   (or your production URL if deploying immediately)
4. Note your **Client ID** and **Client Secret**

### 2. Generate an encryption key

The server encrypts your RC token on disk. Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output into `TOKEN_ENCRYPTION_KEY` in your `.env`. Without this, tokens are not persisted and you must log in again after every restart.

### 3. Start the server

```bash
node index.js
```

### 4. Log in

Visit [http://localhost:3000/login](http://localhost:3000/login) in your browser and complete the RingCentral OAuth flow. After logging in once, the encrypted token is saved to `token.enc` and the server will re-authenticate automatically on all future restarts.

### 5. Run a test backfill

```
http://localhost:3000/recordings/backfill?days=2
```

This downloads the last 48 hours of recordings — a good smoke test before committing to a full backfill. Check progress at `/recordings/status`.

### 6. Full historical backfill

When you're happy everything is working:

```
http://localhost:3000/recordings/backfill?days=90
```

RingCentral retains call logs for 90 days by default (varies by plan). The backfill runs in the background — the server remains responsive while it works. Any recording already in the ledger is automatically skipped, so it is safe to run multiple times.

---

## Configuration

All configuration is via environment variables in `.env`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `RC_SERVER_URL` | ✅ | — | `https://platform.ringcentral.com` (or sandbox URL) |
| `RC_CLIENT_ID` | ✅ | — | Your RC app's Client ID |
| `RC_CLIENT_SECRET` | ✅ | — | Your RC app's Client Secret |
| `RC_REDIRECT_URI` | ✅ | — | Must exactly match what's registered in the RC developer portal |
| `TOKEN_ENCRYPTION_KEY` | ⚠️ | — | 64 hex chars (32 bytes). Required for token persistence across restarts |
| `WEBHOOK_RECEIVER_URL` | — | — | Public HTTPS URL where RC can POST events. Leave blank to use polling only |
| `WEBHOOK_VALIDATION_TOKEN` | — | `rc-recording-hook` | Secret echoed in every webhook POST for verification |
| `POLL_INTERVAL_MS` | — | `300000` | How often to poll for new recordings (ms). `0` = disabled |
| `POLL_LOOKBACK_MS` | — | `86400000` | Minimum lookback window per poll (ms). Default: 24 hours |
| `PORT` | — | `3000` | HTTP port the server listens on |

---

## Routes

| Route | Method | Description |
|---|---|---|
| `/login` | GET | Opens browser for RingCentral OAuth login |
| `/oauth/callback` | GET | OAuth redirect target — RC redirects here after login |
| `/webhook/register` | GET | Subscribe to RC telephony session events for real-time downloads |
| `/webhook/register` | DELETE | Remove the active webhook subscription |
| `/webhook/event` | POST | RC posts events here — do not call manually |
| `/recordings/backfill?days=N` | GET | Queue all recordings from the past N days for download |
| `/recordings/status` | GET | Live queue progress, ledger stats, and rate-limit state |
| `/health` | GET | Machine-readable liveness check — returns 200 or 503 |
| `/calllog/sample` | GET | Returns 5 raw call log records from the past 7 days (debug) |

---

## Webhooks (real-time recording detection)

Webhooks are the preferred way to detect new recordings — the server is notified within seconds of a call ending rather than waiting for the next poll cycle.

### Requirements

RingCentral must be able to reach your server over **public HTTPS**. This means:

- A public domain or subdomain pointing to your server's public IP
- A valid SSL certificate (self-signed will not work)
- Port 443 open inbound on your firewall/router

### Setup

1. Set `WEBHOOK_RECEIVER_URL=https://your-domain.com` in `.env`
2. Restart the server — it will register the webhook automatically on startup
3. Or register manually: `GET /webhook/register`

### Webhook + polling together

You can run both simultaneously. Webhooks catch new recordings in real time; polling acts as a safety net for anything the webhook misses (e.g. recordings that weren't finalized within the detection window). This is the recommended production setup.

### Local development without a public URL

Set `WEBHOOK_RECEIVER_URL` to a tunnel URL from [ngrok](https://ngrok.com):

```bash
ngrok http 3000
# Copy the https://xxx.ngrok.io URL into WEBHOOK_RECEIVER_URL
```

Note that ngrok URLs change on each run (on the free plan), so you'll need to re-register the webhook each session.

---

## Setting up a reverse proxy (LAN deployment)

If your Node server runs on a machine inside a private network and your Windows Server handles inbound traffic, the typical setup is:

```
RingCentral → your-domain.com:443 → Windows Server → Node machine:3000
```

1. **DNS** — point your subdomain's A record to your public IP
2. **Firewall** — forward port 443 inbound to the Windows Server
3. **SSL certificate** — use [win-acme](https://www.win-acme.com) for free Let's Encrypt certificates on Windows
4. **Reverse proxy** — use IIS with the URL Rewrite + ARR modules, or nginx for Windows, to forward requests to the Node machine's internal IP on port 3000

---

## Production deployment

### PM2 (recommended for Node)

```bash
npm install -g pm2
pm2 start ecosystem.config.js --env production
pm2 save        # persist process list
pm2 startup     # generate boot hook — run the printed command
```

Useful commands:
```bash
pm2 logs rc-recorder    # tail logs
pm2 restart rc-recorder # restart
pm2 monit               # live dashboard
```

### systemd (Linux alternative)

```bash
# Edit rc-recorder.service — update User and WorkingDirectory
sudo cp rc-recorder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable rc-recorder
sudo systemctl start rc-recorder
sudo journalctl -u rc-recorder -f   # tail logs
```

---

## Persistent files

The server creates and manages these files at runtime:

| File | Description |
|---|---|
| `token.enc` | Encrypted RC OAuth token. Delete this to force re-login |
| `ledger.json` | Record of every downloaded recording. Prevents re-downloads |
| `webhook.json` | Active RC webhook subscription ID and expiry |
| `downloads/` | Downloaded audio files |

All of these are created with `0600` / `0700` permissions (owner only). All except `downloads/` are in `.gitignore` — do not commit them.

---

## Health monitoring

The `/health` endpoint returns HTTP 200 when everything is operating normally and HTTP 503 with a JSON `issues` array when something needs attention:

```json
{
  "status": "degraded",
  "issues": ["webhook subscription expires in 3 minutes"],
  "authenticated": true,
  "webhookActive": true,
  "webhookExpiresAt": "2026-01-28T15:30:00.000Z",
  "lastPollAt": "2026-01-28T14:25:00.000Z",
  "lastDownloadAt": "2026-01-28T14:20:00.000Z"
}
```

Point any uptime monitoring tool at `/health` to get alerted if the service degrades.

---

## Logs

The server emits newline-delimited JSON to stdout/stderr. Pipe through `jq` for readable output during development:

```bash
node index.js | jq .
```

Each log entry includes a timestamp (`ts`), `level`, `message`, and any relevant context fields. The webhook handler includes an `eventId` field that correlates all log lines belonging to a single incoming event.

---

## .gitignore

```
.env
token.enc
ledger.json
webhook.json
downloads/
logs/
node_modules/
```

Commit `.env.example` (with keys but no values) so others know what to configure.
