
---
doc_type: implementation_plan
date: 20260216
owner: you
status: draft
slug: thought-capture
---

# Implementation Plan: thought-capture

## Links
- PRD: `docs/prd/thought-capture.md`
- Spec: `docs/spec/thought-capture.md`
- ADRs:
  - `docs/adr/0001-storage-engine.md` — Cloudflare D1 (SQLite-based)
  - `docs/adr/0002-llm-provider-and-model.md` — OpenAI GPT-4o-mini
  - `docs/adr/0003-deployment-architecture.md` — Cloudflare Workers

## Milestones (ordered)

### M1 – Data layer
_Target: Week 1 (Days 1-5)_

- [x] Task: Initialize project — TypeScript Worker project using `npm create cloudflare@latest`. Add dependencies: `openai`, `@slack/web-api`. Configure `wrangler.toml` with D1 binding, Queue bindings (producer + consumer for both `thought-classification` and `digest-delivery`), Cron Triggers, and `[vars]` for feature flags. Configure `tsconfig.json`, ESLint, Prettier. Set up Vitest with Miniflare for Workers-compatible testing.
  - DoD: `wrangler dev --local` starts the Worker locally. `npx vitest` runs and passes a trivial test. D1 binding is accessible in the Worker (`env.DB`). Queue bindings are accessible (`env.CLASSIFICATION_QUEUE`, `env.DIGEST_DELIVERY_QUEUE`).
  - Test hook: `npm run build` exits 0. `wrangler dev --local` starts without errors. `npx vitest run` exits 0.

- [x] Task: **Validate `@slack/web-api` Workers compatibility (Day 1 blocker).** Import `WebClient` from `@slack/web-api`, instantiate it in the Worker, and make a test `chat.postMessage` call via `wrangler dev --local`. If it works, proceed with `@slack/web-api`. **If it fails** (e.g., due to Node.js-specific imports like `node:fs` or `node:https`), implement the **fallback `SlackClient`**: a thin wrapper (~50 lines) around raw `fetch` calls to `https://slack.com/api/*` with bearer token auth. The fallback needs 5 methods: `postMessage()`, `updateMessage()`, `addReaction()`, `openConversation()`, `getUserInfo()`. Document the outcome in a code comment at the top of the Slack client module.
  - DoD: Either `@slack/web-api` `WebClient` or the fallback `SlackClient` can successfully call `chat.postMessage` from within a Worker invocation. Decision is documented.
  - Test hook: Integration test via Miniflare: mock Slack API endpoint, verify `SlackClient` (or `WebClient`) sends correct HTTP request with bearer token.
  - Implementation note: `@slack/web-api` was incompatible with Workers runtime (Node-only imports). The fallback fetch-based `SlackClient` is implemented and used; `@slack/web-api` is intentionally not kept as a dependency.

- [x] Task: Create D1 database and initial migration (`migrations/0001_initial_schema.sql`). Define `thoughts`, `user_prefs`, `digest_deliveries`, `analytics_events` tables with all columns, constraints, and indexes from spec. All types are TEXT/INTEGER (SQLite). No `TIMESTAMPTZ`, no `UUID`, no `JSONB`. The `thoughts` table includes `bot_reply_ts` (TEXT, nullable) for emoji reaction override lookup, with an index on `bot_reply_ts`.
  - DoD: `wrangler d1 migrations apply thought-capture-db --local` runs cleanly. All tables and indexes are created. Re-running migration is safe (uses `CREATE TABLE IF NOT EXISTS`).
  - Test hook: Integration test via Miniflare: apply migration, verify tables exist with correct columns via `PRAGMA table_info(thoughts)`. Verify indexes exist via `PRAGMA index_list(thoughts)`. Verify `bot_reply_ts` column exists.

- [x] Task: Implement `ThoughtRepository` — `insert(db, thought)`, `findByUserAndPeriod(db, userId, start, end)`, `findByMessageTs(db, ts)`, `findByBotReplyTs(db, ts)`, `updateClassification(db, id, classification, source, model, latencyMs)`, `updateBotReplyTs(db, id, botReplyTs)`, `updateStatus(db, id, status)`, `purgeExpiredText(db, cutoff90, cutoff180)`. All methods accept the D1 database binding as first argument. UUIDs generated via `crypto.randomUUID()`. Timestamps generated via `new Date().toISOString()`. `findByBotReplyTs()` supports emoji reaction override lookup.
  - DoD: All methods work against local D1 (via Miniflare). Insert is idempotent via `ON CONFLICT (slack_message_ts) DO NOTHING`. Queries return expected results for test data. `findByBotReplyTs()` correctly looks up thoughts by bot reply message TS.
  - Test hook: Integration tests for each method with seeded test data. Test idempotent insert (duplicate `slack_message_ts`). Test TTL purge (insert old record, run purge, verify text is NULL). Test status update. Test `findByBotReplyTs()` lookup.

- [x] Task: Implement `UserPrefsRepository` — `upsert(db, prefs)`, `findByUserId(db, userId)`, `findAllPrefs(db)`. Implement `isDigestDue(prefs, now)` as a pure function using `Intl.DateTimeFormat` for timezone conversion. This replaces the Postgres `AT TIME ZONE` query — timezone eligibility is computed in TypeScript.
  - DoD: `isDigestDue()` correctly identifies users whose local time matches the current 15-minute window. Tested with users in `America/New_York`, `America/Los_Angeles`, `Europe/London`, and `Asia/Tokyo` timezones. DST edge cases tested.
  - Test hook: Unit test: call `isDigestDue()` with known timestamps and timezones. Integration test: insert users with different timezones, call `findAllPrefs()`, filter with `isDigestDue()`, verify only the correct users are returned.

- [x] Task: Implement `AnalyticsRepository` — `logEvent(db, type, userId, properties)`. Append-only insert. Properties stored as `JSON.stringify(properties)` in TEXT column.
  - DoD: Events are inserted with correct types and timestamps. JSON properties round-trip correctly (`JSON.parse()` on read).
  - Test hook: Integration test: insert event with properties `{ from: 'noise', to: 'action_required' }`, query back, verify `JSON.parse(properties)` matches.

### M2 – API layer
_Target: Week 2 (Days 6-10)_

- [x] Task: Implement Worker `fetch` handler skeleton — route by path (`/slack/events`, `/slack/interactions`, `/slack/commands`, `/health`). Implement `SlackVerifier` for HMAC-SHA256 signature verification using Web Crypto API (`crypto.subtle`) with **timing-safe double-HMAC comparison** (not string `===`). Implement Slack URL verification challenge handler (`{ "challenge": "..." }` response). Add `/health` endpoint that queries D1 for basic stats. Implement `scheduled` handler with `event.cron` switch dispatch (3 patterns: `*/15 * * * *` for digest, `0 3 * * *` for TTL, `*/5 * * * *` for catch-up). Implement `queue` handler with `batch.queue` switch dispatch (2 queues: `thought-classification`, `digest-delivery`).
  - DoD: Worker starts via `wrangler dev`. `/health` returns 200 with JSON status. Slack URL verification challenge returns correct response. Invalid signatures are rejected with 401. `scheduled` handler dispatches correctly to the right function based on `event.cron`. `queue` handler dispatches correctly based on `batch.queue`.
  - Test hook: Unit test: HMAC verification with known test vectors (from Slack docs) — verify timing-safe comparison works. Integration test: `/health` returns `{ status: "ok", timestamp: "..." }`. Test invalid signature rejection. Test `event.cron` dispatch routing. Test `batch.queue` dispatch routing.

- [x] Task: Implement `handleDirectMessage` — full flow: verify signature, parse event, return HTTP 200 immediately, use `ctx.waitUntil()` for async work: check idempotency via D1, create/fetch user prefs (fetch timezone from Slack `users.info` API via `@slack/web-api`), send welcome message if first interaction, persist thought to D1, add checkmark reaction via Slack API, enqueue thought ID to Classification Queue (`env.CLASSIFICATION_QUEUE.send()`).
  - DoD: Sending a simulated `message.im` event results in: HTTP 200 returned immediately, thought row in D1 with `classification = 'unclassified'`, user_prefs row created with correct timezone, checkmark reaction sent. Duplicate messages are silently dropped. Non-text messages get a helpful error reply.
  - Test hook: Integration test (mock Slack API, real D1 via Miniflare): send simulated event, verify D1 state. Test duplicate message handling. Test non-text message response. Test welcome message on first interaction.

- [x] Task: Implement `ClassificationService` — OpenAI API call using `openai` SDK (Workers-compatible, uses `fetch`). Classification prompt from spec. Response parsing with enum validation. Invalid response fallback to `action_required`. Timeout after 25 seconds (to fit within Queue consumer limits).
  - DoD: Valid responses are parsed correctly. Invalid responses default to `action_required`. Timeout handling works.
  - Test hook: Unit test with mocked `fetch`: test valid response, invalid response, timeout. Verify correct classification and fallback behavior.

- [x] Task: Implement Queue consumer (`queue` handler in Worker, dispatched for `thought-classification` queue) — receive `{ thoughtId, userId }` messages from Classification Queue. Fetch thought from D1, call `ClassificationService`, update D1 with classification result, send Slack classification reply (e.g., "Got it — classified as Action Required"), **store the bot reply TS** in `thoughts.bot_reply_ts` for emoji reaction override lookup. Handle errors by throwing (Cloudflare Queues will retry).
  - DoD: After thought is enqueued, classification completes within 30s (P95). Reply is posted to user's DM channel. `bot_reply_ts` is stored in D1. If classification fails, error is thrown and Queues retry. After max retries, message goes to DLQ.
  - Test hook: Integration test via Miniflare: enqueue message, verify D1 is updated with classification and `bot_reply_ts`. Test failure path: mock OpenAI failure, verify message is retried. Test DLQ: exhaust retries, verify message in DLQ.

- [x] Task: Implement `handleClassificationOverride` (text) and `handleReactionOverride` (emoji). Parse "reclassify as action/reference/noise" text and pushpin/file_folder/wastebasket emoji reactions. For emoji reactions, look up thought by `bot_reply_ts` first (user reacts to bot's classification reply), then fall back to `slack_message_ts` (user reacts to their own original message). Verify the reacting user matches the thought's author. Update thought classification and source in D1. Send confirmation reply. Log analytics event.
  - DoD: Text override and emoji override both correctly update the most recent thought's classification. Emoji override correctly resolves via `bot_reply_ts`. Confirmation message is sent. Override analytics event is logged with `from_category` and `to_category`.
  - Test hook: Integration test: create thought with `bot_reply_ts` in D1, send emoji reaction event with `item.ts` matching `bot_reply_ts`, verify D1 update and analytics event. Test edge case: no recent thought found. Test emoji on non-thought message (should be ignored). Test reaction from a different user (should be ignored).

- [x] Task: Implement `/thoughtcapture schedule` slash command handler. Parse `POST /slack/commands` payload. Parse day + time input, validate, upsert user_prefs in D1. Return Slack-formatted response.
  - DoD: Valid input updates schedule in D1. Invalid input returns usage help. Confirmation shows day, time, and timezone.
  - Test hook: Unit test: parse valid inputs ("monday 9:00", "Friday 14:30", "sunday 0:00"). Parse invalid inputs ("funday 25:00", "monday", ""). Integration test: slash command updates D1.

### M3 – UI layer
_Target: Week 3 (Days 11-15)_

- [ ] Task: Implement `DigestService` — query pending items (action_required + snoozed + unclassified) from D1, build Block Kit payload per spec, handle empty-week message. Date arithmetic for period start/end computed in TypeScript (no SQL `INTERVAL`).
  - DoD: Block Kit JSON matches spec layout. Snoozed items are included when `snooze_until <= now`. Unclassified items appear under "Needs Review" header. Empty-week message shows thought count and classification breakdown.
  - Test hook: Unit test: build digest from fixture data. Test with 0 items, 1 item, 10 items, mix of action + snoozed + unclassified. Verify Block Kit structure.

- [ ] Task: Implement digest Cron Trigger handler + Digest Delivery Queue consumer — **Cron handler (scheduled, `*/15 * * * *`):** call `findAllPrefs()`, filter with `isDigestDue()`, check for existing deliveries (idempotency), and **enqueue** a `{ userId, periodStart, periodEnd }` message to the `DIGEST_DELIVERY_QUEUE` for each eligible user. The cron does NOT send Slack messages — it only enqueues. **Queue consumer (dispatched for `digest-delivery` queue):** receive user message, re-check delivery idempotency, query action items from D1, open DM channel via `conversations.open`, generate and send digest via `DigestService`, record delivery in `digest_deliveries`, log `digest.sent` analytics event. Handle per-user failures independently (throw error -> Queue retries).
  - DoD: Digest is sent to test user at configured time. `digest_deliveries` row is created in D1. Duplicate delivery is prevented by UNIQUE constraint. Failure for one user doesn't block others (each user is a separate Queue message). Cron handler completes in <5 seconds (no Slack API calls).
  - Test hook: Integration test: insert user with known schedule, invoke `scheduled` handler with matching timestamp, verify message enqueued to Digest Delivery Queue. Then invoke Queue consumer with the enqueued message, verify digest sent (mock Slack API) and delivery recorded in D1. Test duplicate prevention: invoke twice, verify single delivery. Test failure isolation: mock Slack failure for one user's Queue message, verify retry occurs.

- [ ] Task: Implement `handleDigestButtonAction` — process "Acted on", "Snooze", "Dismiss" button taps from `POST /slack/interactions`. Update thought status in D1. Update Slack message via `chat.update` (replace buttons with status text). Log analytics event. Snooze computes `snooze_until` via `new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()`.
  - DoD: Each button tap updates thought status correctly in D1. Slack message is updated with status text (e.g., "Marked as acted on"). Snooze sets `snooze_until` to 7 days from now. Re-tapping is idempotent. Analytics event is logged.
  - Test hook: Integration test: create thought and simulate button tap, verify D1 status change and Slack message update. Test all three actions. Test idempotent re-tap.

- [ ] Task: Implement welcome message — sent on first DM if `user_prefs.welcomed = 0`. Block Kit message explaining: what the bot does, how to capture, when digests arrive, how to override, how to change schedule.
  - DoD: First DM triggers welcome + checkmark. Second DM triggers only checkmark (no welcome). Welcome message is well-formatted Block Kit.
  - Test hook: Integration test: first message triggers welcome, second does not. Verify `welcomed` flag in D1.

- [ ] Task: Implement TTL cleanup Cron Trigger — in `scheduled` handler, dispatched via `event.cron === '0 3 * * *'`. Purge thought text older than 90 days. Hard-delete records older than 180 days (except `acted_on`). Purge old analytics events. All date cutoffs computed in TypeScript. Log results.
  - DoD: Text is purged (set to NULL) for thoughts >90 days old. Records >180 days old (non-`acted_on`) are deleted. `acted_on` metadata is preserved. Log shows counts.
  - Test hook: Integration test: insert thoughts with various ages (using old ISO timestamps) and statuses. Invoke scheduled handler. Verify: 91-day-old text is NULL, 91-day-old `acted_on` text is NULL but row exists, 181-day-old noise is deleted, 181-day-old `acted_on` is preserved.

- [ ] Task: Implement classification catch-up Cron Trigger — in `scheduled` handler, dispatched via `event.cron === '*/5 * * * *'`. Query D1 for thoughts with `classification = 'unclassified'` older than 5 minutes but younger than 1 hour. Re-enqueue to Classification Queue.
  - DoD: Stale unclassified thoughts are re-enqueued. Thoughts that are already being processed (queue consumer in-flight) are handled idempotently by the `WHERE classification = 'unclassified'` guard on the update.
  - Test hook: Integration test: insert unclassified thought with `created_at` 10 minutes ago, invoke scheduled handler, verify message enqueued to Queue.

### M4 – Tests + hardening
_Target: Week 4 (Days 16-18)_

- [ ] Task: Write comprehensive unit tests — target 80%+ coverage on `ClassificationService`, `DigestService`, `SlackVerifier`, slash command parser, override handler, Block Kit builder, `isDigestDue()` timezone logic.
  - DoD: `npx vitest run` passes. Coverage report shows >=80% line coverage on core services.
  - Test hook: `npx vitest run --coverage` exits 0. Coverage threshold enforced.

- [ ] Task: Write integration tests against local D1 (via Miniflare) — thought lifecycle (create -> classify -> digest -> act on), timezone-aware digest scheduling, TTL cleanup, idempotency, Queue consumer processing.
  - DoD: `npx vitest run` passes with all integration tests. Full thought lifecycle test completes end-to-end.
  - Test hook: `npx vitest run` exits 0 (integration tests use Miniflare — no Docker, no external services).

- [ ] Task: Perform E2E smoke test in Slack test workspace — manually execute full flow: send 5 thoughts, verify classifications, trigger digest (wait for cron or manually invoke), tap all 3 button types, override a classification, change schedule.
  - DoD: All steps complete successfully. Screenshots/recording captured as evidence. Any bugs found are logged and fixed.
  - Test hook: Written checklist with pass/fail for each step.

- [ ] Task: Harden error handling — verify all 7 failure modes from spec. Test: LLM timeout/failure (Queue retry + DLQ), D1 unavailability (HTTP 500 to Slack), Slack API failure (digest retry on next cron), duplicate events (idempotent insert), invalid LLM response (fallback to `action_required`), Worker CPU time limit (verify handlers are well within 30s), Queue message loss (catch-up cron).
  - DoD: Each failure mode is tested (mocked via Miniflare) and handled per spec. No unhandled promise rejections. No silent data loss. Structured error logs for all failure paths.
  - Test hook: Unit/integration tests for each failure mode. `npx vitest run` exits 0.

- [ ] Task: Performance spot-check — measure P95 latencies for: thought ack (<2s), classification (<30s), button interaction response (<2s). Verify at 100-user digest simulation: invoke digest cron with 100 users in D1, verify cron handler enqueues 100 messages in <5 seconds (well within 30s CPU limit). Invoke 100 Digest Delivery Queue consumer messages, measure per-user digest generation time and total Slack API calls.
  - DoD: Measured latencies are within spec targets. Cron handler at 100 users completes in <5 seconds. Per-user digest delivery via Queue completes within 15 minutes total.
  - Test hook: Performance test script output showing P95 numbers.

### M5 – Release
_Target: Week 4 (Days 19-20)_

- [x] Telemetry: Verify all analytics events are being logged correctly. Run D1 queries to compute override rate, digest engagement rate, and active user count from `analytics_events`. Verify `/health` endpoint returns key metrics.
  - DoD: All PRD-defined events (`thought.captured`, `thought.classified`, `thought.override`, `digest.sent`, `digest.item.acted_on`, `digest.item.snoozed`, `digest.item.dismissed`, `digest.engagement`) are logged with correct properties. Override rate formula returns correct value against test data.
  - Test hook: Query `analytics_events` table in D1, verify event types and properties match spec.

- [x] Runbook: Write operational runbook covering: how to deploy (`wrangler deploy`), how to check health (`/health` endpoint), how to read logs (Workers Logs / `wrangler tail`), how to handle each alert, how to run reclassification script (enqueue to Queue), how to disable/rollback (`wrangler rollback`, feature flag), how to add/remove users from beta (update `ENABLED_USER_IDS` in `wrangler.toml`), how to manage secrets (`wrangler secret put`), how to inspect DLQs (`wrangler queues` — both `thought-classification-dlq` and `digest-delivery-dlq`).
  - DoD: Runbook is in `docs/runbook/thought-capture.md`. Another engineer could operate the system using only the runbook.
  - Test hook: Peer review of runbook (or self-review using "could I do this at 3 AM?" test).

- [ ] Flag rollout: Create D1 database (`wrangler d1 create thought-capture-db`). Apply migrations (`wrangler d1 migrations apply thought-capture-db --remote`). Set secrets (`wrangler secret put SLACK_BOT_TOKEN`, `wrangler secret put SLACK_SIGNING_SECRET`, `wrangler secret put OPENAI_API_KEY`). Deploy Worker (`wrangler deploy`). Set `THOUGHT_CAPTURE_V1_ENABLED="true"` and `ENABLED_USER_IDS` to 5 dogfood user IDs in `wrangler.toml`. Re-deploy. Monitor logs via `wrangler tail` for 24 hours. Verify first digest delivery.
  - DoD: Bot is live in production Slack workspace. 5 dogfood users can send thoughts and receive digests. No errors in `wrangler tail`. First digest delivered successfully.
  - Test hook: Verify in Slack: send thought, see checkmark and classification. Verify in logs (`wrangler tail`): no errors. Verify in D1 (`wrangler d1 execute`): thought record exists with correct classification.

## Definition of Done (global)
- [ ] CI green (build + unit tests + integration tests via Vitest + Miniflare)
- [ ] Test plan executable (unit, integration, E2E checklist)
- [ ] Runbook written (`docs/runbook/thought-capture.md`)
- [ ] Success metric instrumented (override rate, digest engagement rate, active user count — all queryable from analytics_events in D1)
- [ ] Feature flag operational (can disable bot with single `wrangler.toml` var change + deploy, or instant rollback via `wrangler rollback`)
- [ ] All 7 failure modes from spec are tested and handled
- [ ] P95 latencies verified: thought ack <2s, classification <30s, button response <2s
- [ ] Zero Docker dependencies — all local dev and testing via `wrangler dev --local` + Vitest + Miniflare
