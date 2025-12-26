# Telegram Hourly Bonus Clicker

## Purpose

- Continuously runs a worker that iterates saved Telegram user sessions and claims hourly bonuses from @CatStarssRobot.

## Features

- Sequential account processing with per-account timeouts.
  -- Eligibility check: only clicks if last_click was >= configured `ELIGIBILITY_MINUTES` (default: 240 minutes / 4 hours).
- Flood-wait handling: respects Telegram rate-limit responses.
- HTTP endpoints for keepalive and manual trigger.
- Per-account `in_progress` lock: crashes mid-run don't corrupt state.
- Session storage: local JSON or Supabase.

## Quick start (local)

1. Copy `.env.example` to `.env` and fill values:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Start the service:

```bash
npm start
```

Server will start on `http://localhost:3000` by default.

## HTTP endpoints

- **GET /health** — Returns 200 + timestamp. Use for keepalive pings.
- **POST /run?token=SECRET** — Triggers a single `runOnce()` run. Requires `RUN_SECRET` token. Returns 409 if a run is already in progress.

Example requests:

```bash
# Health check (no auth required)
curl http://localhost:3000/health

# Trigger a run (requires token)
curl -X POST "http://localhost:3000/run?token=your-super-secret-token-change-this"
```

## Render + UptimeRobot setup

1. Deploy to Render Web Service with `npm start`
2. Set environment variables in Render (use secrets for sensitive values)
3. Configure UptimeRobot to trigger your run endpoint. Recommended options:

- Option A (combined keepalive + trigger): POST every 5 minutes to `/run?token=...` — keeps service awake and will trigger eligible accounts; the worker prevents overlapping runs.
- Option B (trigger-only): POST every 4 hours (240 minutes) to `/run?token=...` — recommended if you prefer less frequent triggers. Ensure Render doesn't sleep between runs; if it does, prefer Option A.

Either option is fine — choose A to guarantee the service stays awake, or B if you only want runs every 4 hours.

## Environment variables

- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — Required; get from my.telegram.org
- `BOT_USERNAME` — Target bot, default `@CatStarssRobot`
- `ELIGIBILITY_MINUTES` — Min minutes since last_click, default 55
- `SESSIONS_SOURCE` — "local" or "supabase"
- `LOCAL_SESSIONS_FILE` — Path to sessions.json if local
- `RUN_SECRET` — Token for /run endpoint (change in production!)
- `HTTP_PORT` — Port, default 3000

See `.env.example` for all options.

## Crash resilience

- Per-account `in_progress` lock: if Render stops mid-run, stale locks are cleared on startup (1 hr timeout).
- Flood-wait or timeout: account resets to `active`, retries on next run.
- Duplicate protection: HTTP lock prevents overlapping runs.

## Logging

JSON-formatted logs to stdout. Never log session strings.

## Warnings

- Automating Telegram accounts may violate ToS. Use at your own risk.
- If you see repeated flood-waits or bans, Telegram has detected automation. Stop immediately.
- Test locally first before production.
