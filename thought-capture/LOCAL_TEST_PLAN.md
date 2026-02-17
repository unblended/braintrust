# Local Test Plan (Staging + Production Envs)

This checklist validates Wrangler environment config (`staging`, `production`) and core app behavior locally.

## 1) One-time setup

1. Copy secret template:
   - `cp .dev.vars.example .dev.vars`
2. Fill `.dev.vars` with real values:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `OPENAI_API_KEY`
   - `ENABLED_USER_IDS` (comma-separated Slack user IDs, no brackets)
3. Install dependencies:
   - `npm ci`

## 2) Config and unit/integration validation

Run these from `thought-capture/`:

- `npm run validate:config`
- `npm test`

Expected:
- All three dry-run deploys pass (default, staging, production).
- Test suite passes.

## 3) Prepare local D1 state for both envs

- `npm run migrate:local:staging`
- `npm run migrate:local:production`

Expected:
- Both commands apply migrations successfully to local persisted state.

## 4) Runtime smoke test (staging)

1. Start worker:
   - `npm run dev:staging`
2. In another terminal:
   - `curl -sS http://127.0.0.1:8787/health | jq`
   - `curl -sS -X POST "http://127.0.0.1:8787/__scheduled?cron=*/15+*+*+*+*"`
   - `curl -sS -X POST "http://127.0.0.1:8787/__scheduled?cron=0+3+*+*+*"`
   - `curl -sS -X POST "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"`

Expected:
- `/health` returns `status: "ok"`.
- Scheduled endpoints return 200 and no runtime errors appear in dev logs.

## 5) Live OpenAI classification path (local)

Use a real Slack user ID included in `ENABLED_USER_IDS`.

1. Seed user preferences (prevents first-message timezone lookup dependency):
   - `npx wrangler d1 execute thought-capture-db --local --persist-to .wrangler/state --command "INSERT OR REPLACE INTO user_prefs (slack_user_id,digest_day,digest_hour,digest_minute,timezone,welcomed,created_at,updated_at) VALUES ('U_YOUR_USER_ID',1,9,0,'America/New_York',1,datetime('now'),datetime('now'));"`
2. Send a signed local Slack DM event:
   - `npm run local:send-event -- --user U_YOUR_USER_ID --text "we should retire legacy auth path"`
3. Verify thought classified in local D1:
   - `npx wrangler d1 execute thought-capture-db --local --persist-to .wrangler/state --command "SELECT id,classification,classification_model,classification_source,created_at FROM thoughts ORDER BY created_at DESC LIMIT 5;"`

Expected:
- Event endpoint returns HTTP 200.
- New thought row appears and classification is one of `action_required`, `reference`, or `noise`.

## 6) Repeat smoke in production env

1. Stop staging dev server.
2. Start production dev server:
   - `npm run dev:production`
3. Repeat section 4 checks.

## 7) Optional negative checks

- Invalid signature check:
  - Send request with wrong `SLACK_SIGNING_SECRET`; expect HTTP 401.
- Feature-flag kill switch:
  - Set `THOUGHT_CAPTURE_V1_ENABLED="false"` in `.dev.vars`, restart dev server, verify message/cron flows are blocked.
