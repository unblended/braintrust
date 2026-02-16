---
doc_type: runbook
date: 20260216
owner: you
status: active
slug: thought-capture
---

# Runbook: Thought Capture

## Purpose
Operational guide for the `thought-capture` Cloudflare Worker (Slack DM ingestion, classification queue, digest queue, cron jobs, and D1 data).

## Deploy
1. From repo root, switch to the Worker package:
   - `cd thought-capture`
2. Run release gates locally:
   - `npx vitest run`
   - `npm run build`
3. Ensure required secrets exist:
   - `npx wrangler secret put SLACK_BOT_TOKEN`
   - `npx wrangler secret put SLACK_SIGNING_SECRET`
   - `npx wrangler secret put OPENAI_API_KEY`
4. Apply database migrations:
   - `npx wrangler d1 migrations apply thought-capture-db --remote`
5. Deploy:
   - `npx wrangler deploy`
6. Post-deploy smoke check:
   - `curl -sS https://<worker-url>/health`
   - Send a DM from an allowlisted user and verify checkmark reaction + classification reply.

## Health checks
- Endpoint: `GET /health`
- Command: `curl -sS https://<worker-url>/health | jq`
- Expected keys:
  - `status` is `ok`
  - `metrics.total_thoughts`
  - `metrics.classifications`
  - `metrics.active_users_14d`
  - `metrics.override_rate_7d`
  - `metrics.digest_engagement_rate_7d`
- If `status != ok` or endpoint fails, treat as SEV-1 for beta users.

## Logs
- Live tail:
  - `npx wrangler tail --format pretty`
- Key structured events to filter for:
  - `thought.ingested`
  - `thought.classified`
  - `thought.classification_failed`
  - `thought.overridden`
  - `digest.sent`
  - `digest.delivery_failed`
  - `digest.button_tapped`
  - `ttl.purged`
- Triage note: never log or share raw thought text during incident response.

## DLQ and queue operations
- Queue health:
  - `npx wrangler queues info thought-classification`
  - `npx wrangler queues info digest-delivery`
- DLQ depth checks:
  - `npx wrangler queues info thought-classification-dlq`
  - `npx wrangler queues info digest-delivery-dlq`
- Pause/resume delivery (safe mitigation):
  - `npx wrangler queues pause-delivery thought-classification`
  - `npx wrangler queues resume-delivery thought-classification`
  - `npx wrangler queues pause-delivery digest-delivery`
  - `npx wrangler queues resume-delivery digest-delivery`
- Replay guidance:
  - Classification failures are auto-healed by the `*/5` catch-up cron for stale unclassified thoughts.
  - For digest DLQ messages, resolve root cause first (Slack/API/permissions), then replay via Cloudflare dashboard queue tooling.

## Dashboards & alerts
- Dashboard:
  - Cloudflare Workers dashboard for `thought-capture`
  - Cloudflare D1 dashboard for `thought-capture-db`
  - Cloudflare Queues dashboard for `thought-classification`, `digest-delivery`, and DLQs
- Alerts:
  - LLM/classification error rate >5% over 5 minutes
  - Any digest delivery failures exhausting retries
  - DLQ depth >0
  - Override rate >20% over trailing 7 days
  - Zero thoughts captured in 24 hours during active beta

## Symptoms
- What users report:
  - "My DM got no checkmark"
  - "No classification reply"
  - "I did not get this week's digest"
  - "Buttons in digest do nothing"
- What you see in metrics/logs:
  - Spikes in `thought.classification_failed` or `digest.delivery_failed`
  - `override_rate_7d` rising above 0.20
  - DLQ message counts >0
  - `active_users_14d` drops unexpectedly

## Triage checklist (5-10 minutes)
1. Confirm impact scope (single user vs all allowlisted users).
2. Check recent deploys and flag changes (`THOUGHT_CAPTURE_V1_ENABLED`, `ENABLED_USER_IDS`).
3. Check `/health` for metric anomalies.
4. Tail logs and identify top error signatures.
5. Check queue and DLQ depth for classification and digest pipelines.
6. Verify external dependencies (Slack API status, OpenAI status, Cloudflare status).

## Known failure modes
- FM1: LLM API failure/timeouts -> classification retries and eventual DLQ. Fix: verify OpenAI status, keys, and retry behavior.
- FM2: D1 outage -> no thought persistence/checkmark. Fix: monitor Cloudflare incident status, rely on Slack retries for short outages.
- FM3: Slack API failures during digest send -> user misses digest. Fix: inspect `digest.delivery_failed`, resolve Slack auth/rate-limit issues.
- FM4: Duplicate Slack events -> potential duplicate processing attempts. Mitigated by `slack_message_ts` uniqueness.
- FM5: Invalid LLM output -> fallback classification (`action_required`). Monitor and tune prompt.
- FM6: Worker/Cron execution pressure -> missed scheduling windows. Verify cron runs and queue enqueue counts.
- FM7: DLQ buildup -> persistent failures not auto-recovered. Investigate and replay after fix.

## Mitigations (safe actions)
- Restart: not applicable (serverless). Redeploy only if code/config fix is required.
- Disable flag (global kill switch):
  - Set `THOUGHT_CAPTURE_V1_ENABLED = "false"` in `thought-capture/wrangler.toml`
  - `npx wrangler deploy`
- Narrow beta cohort:
  - Update `ENABLED_USER_IDS` in `thought-capture/wrangler.toml`
  - `npx wrangler deploy`
- Pause queue delivery temporarily while triaging downstream outages:
  - Use `wrangler queues pause-delivery ...`

## Playbooks
- Classification failures increasing:
  1. Check `thought.classification_failed` logs for common error.
  2. Confirm `OPENAI_API_KEY` validity.
  3. Confirm catch-up cron still running (`*/5` schedule).
  4. If needed, pause rollout (`THOUGHT_CAPTURE_V1_ENABLED=false`) until stable.
- Digest failures:
  1. Check `digest.delivery_failed` logs and Slack API errors.
  2. Verify bot scopes and channel open permissions.
  3. Inspect digest DLQ depth.
  4. Replay failed messages after fix.
- High override rate (>20%):
  1. Confirm metric from `/health`.
  2. Query recent `thought.override` events and spot patterns.
  3. Pause user expansion; keep existing users stable.
  4. Tune classification prompt before re-expansion.
- Zero captures in 24h:
  1. Verify feature flags and allowlist are not empty by mistake.
  2. Send a test DM from allowlisted user.
  3. Validate Slack event signature handling and endpoint reachability.

## Rollback
- What to rollback:
  - Code regressions: rollback Worker version.
  - Behavioral regressions: disable feature flag first, then rollback if needed.
- Commands:
  - `npx wrangler versions list`
  - `npx wrangler rollback <version-id>`
- How to validate rollback worked:
  - `/health` returns `status=ok`
  - New DMs either process normally (if enabled) or return temporary-unavailable message (if disabled)
  - Queue failure logs return to baseline

## Data fixes (danger zone)
- Preconditions:
  - Root cause identified and fixed.
  - Deploy state stable for at least 15 minutes.
  - Snapshot/backup plan agreed for any destructive SQL.
- Steps:
  1. Identify affected thoughts/events:
     - `npx wrangler d1 execute thought-capture-db --remote --command "SELECT id, slack_user_id, created_at FROM thoughts WHERE classification = 'unclassified' ORDER BY created_at DESC LIMIT 200;"`
  2. For classification backlog, rely on catch-up cron first; if backlog remains, enqueue specific thoughts to `thought-classification` using queue tooling.
  3. For incorrect digest state, inspect `digest_deliveries` and resend only after confirming user-safe behavior.
- Validation:
  - Spot-check updated rows in D1.
  - Confirm no unexpected spikes in retry/DLQ metrics.
- Backout plan:
  - Stop manual replay.
  - Re-disable feature flag if user impact increases.
  - Restore from last known-good backup/export if a destructive change was applied.

## Escalation
- Who to notify:
  - Feature owner/on-call engineer
  - Slack workspace admin (for token/scope issues)
  - Platform owner (Cloudflare service incident)
- What info to include:
  - Incident start time and user impact
  - Recent deploy/version ID
  - Current flag settings
  - Top error signatures from logs
  - Queue + DLQ depths
  - `/health` metric snapshot
