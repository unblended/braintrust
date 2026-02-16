
---
doc_type: testplan
date: 20260216
owner: you
status: draft
slug: thought-capture
---

# Test Plan: thought-capture

## Scope

**Covers:** All functionality defined in `docs/prd/thought-capture.md` (AC1–AC10), all API endpoints and internal operations from `docs/spec/thought-capture.md`, all security controls from `docs/security/thought-capture-threat-model.md`, and the rollback plan. This plan is designed for a solo engineer to execute in ≤30 minutes using Vitest + Miniflare (automated tests) plus a short manual E2E checklist against a Slack test workspace.

**Does not cover:** Performance benchmarking at >100 users, Slack API uptime/reliability testing, OpenAI model accuracy evaluation (that is the Week 0 validation experiment in the PRD), multi-workspace Slack distribution, or any NG1–NG7 non-goals.

## Environments

- **Local:** `wrangler dev --local` with local D1 (SQLite), Miniflare-simulated Queues. All unit and integration tests run here via `npx vitest run`. Zero Docker dependencies.
- **Staging:** N/A — there is no staging environment. The Cloudflare Workers free tier serves as a single deployment target. Dogfood (Week 5) acts as a soft staging gate.
- **Production:** Cloudflare Workers deployed via `wrangler deploy`. D1 database `thought-capture-db`. Feature-flagged to `ENABLED_USER_IDS` allowlist. Monitored via `wrangler tail` and `/health` endpoint.

## Test data

- **Seed data needed:**
  - 5 user_prefs records with distinct timezones: `America/New_York`, `America/Los_Angeles`, `Europe/London`, `Asia/Tokyo`, `Pacific/Auckland`.
  - 20 thought records per user (100 total) spanning: `action_required`, `reference`, `noise`, `unclassified` classifications. Mix of `open`, `acted_on`, `snoozed`, `dismissed` statuses. Include thoughts with old `created_at` timestamps (91 days, 181 days) for TTL tests.
  - 2 digest_deliveries records per user for idempotency tests.
  - 10 analytics_events records of each event type.
  - 1 thought with `text` length = 10,000 characters (truncation test).
  - 1 thought with `bot_reply_ts` set (emoji reaction override test).

- **Accounts/roles needed:**
  - 1 Slack test workspace with the Thought Capture bot installed.
  - 2 Slack test user accounts: one in `ENABLED_USER_IDS` (authorized), one not (unauthorized).
  - 1 OpenAI API key with GPT-4o-mini access (for live integration test — rate-limited to 1 call/test run).

## Happy path (manual)

_Execute in Slack test workspace. Estimated time: 8 minutes._

1. **Thought capture + ack (AC1).** Open DM with bot. Send "we should deprecate the v1 auth service before Q3." Verify: ✅ reaction appears on message within 2 seconds. Verify: bot replies with classification label (e.g., "Got it — classified as 📌 Action Required") within 30 seconds (AC2).
2. **Classification override via text (AC3).** Reply "reclassify as reference." Verify: bot replies "Updated! Reclassified as 📁 Reference (was Action Required)."
3. **Classification override via emoji (AC3).** Send a new thought "investigate perf cliff in payment service." After bot classifies it, react to the bot's reply with 📌 (`:pushpin:`). Verify: classification changes to `action_required` (confirm via next digest or by sending another override).
4. **Digest delivery (AC4).** Wait for digest delivery at configured time (or manually invoke the scheduled handler via `wrangler dev`). Verify: Block Kit message arrives with header "Your Action Items This Week (N items)." Each item shows original text, capture date, and three buttons: "Acted on," "Snooze 1 week," "Dismiss."
5. **Button interactions (AC5).** Tap "Acted on" on one item. Verify: button row replaced with "✅ Marked as acted on." Tap "Snooze" on another. Verify: replaced with "⏰ Snoozed until [date 7 days out]." Tap "Dismiss" on another. Verify: replaced with "🗑 Dismissed."
6. **Schedule change (AC4 — configurable day/time).** Run `/thoughtcapture schedule friday 14:00`. Verify: bot responds "Digest schedule updated: Friday at 14:00 (America/New_York)."
7. **Welcome message.** Create a new test user (or clear `welcomed` flag in D1). Send first DM. Verify: bot sends welcome message explaining features before the normal capture flow.
8. **Empty-week digest (AC7).** Ensure no `action_required` items exist for a user (override all to `reference` or `noise`). Trigger digest. Verify: message reads "No action items this week. You captured N thoughts — X Reference, Y Noise."

## Edge cases (15 scenarios; ≥10 required)

_All edge cases are covered by automated tests (see next section). This list documents the scenarios._

1. **Non-text message (image/file).** Send an image attachment to the bot DM. Verify: bot replies "I can only capture text thoughts right now. Try typing it out!" No thought record is persisted.
2. **Duplicate Slack event delivery.** Replay the same `message.im` event (same `slack_message_ts`). Verify: second event is silently dropped via `ON CONFLICT DO NOTHING`. No duplicate thought in D1.
3. **LLM API failure — classification fallback (AC6).** Simulate OpenAI API timeout (mock). Verify: thought is persisted with `classification = 'unclassified'`. Queue retries up to 3 times. After exhaustion, message goes to DLQ. Thought appears in next digest under "Needs Review" section.
4. **Classification returns invalid value.** Mock LLM returning "maybe_important" (not in enum). Verify: classification defaults to `action_required` (fail safe). Warning logged with raw response.
5. **Thought text exceeds 4,000 characters (D-4 mitigation).** Submit a 10,000-character thought. Verify: only 4,000 characters stored in D1. User notified of truncation. LLM receives truncated text.
6. **Per-user rate limit — 60 thoughts/hour (D-1 mitigation).** Insert 60 thoughts for a user within 1 hour, then send a 61st. Verify: 61st is rejected with rate limit message. Thought is NOT persisted.
7. **Unauthorized user sends DM (E-2 mitigation).** Send DM from a user NOT in `ENABLED_USER_IDS`. Verify: bot replies "Thought Capture is currently in private beta." No thought persisted.
8. **Feature flag disabled.** Set `THOUGHT_CAPTURE_V1_ENABLED = "false"`. Send DM. Verify: bot replies "Thought Capture is temporarily unavailable." No thought persisted. Trigger cron. Verify: no digests sent.
9. **Cross-user button interaction (E-3 / T-2 mitigation).** Submit a Block Kit button interaction with `user.id = U_ATTACKER` for a thought owned by `U_VICTIM`. Verify: status is NOT updated. Warning logged.
10. **Replay attack — old Slack timestamp (S-2 mitigation).** Send a request with `x-slack-request-timestamp` older than 5 minutes (but valid HMAC). Verify: request rejected with HTTP 401.
11. **Override with no recent thought.** Send "reclassify as action" when no thought exists within 24 hours. Verify: bot replies "I couldn't find a recent thought to reclassify."
12. **Emoji reaction from non-owner (E-5 mitigation).** Simulate a `reaction_added` event where `event.user` does not match `thought.slack_user_id`. Verify: reaction is silently ignored, classification unchanged.
13. **Snoozed item reappears in next digest.** Create a thought, mark as snoozed with `snooze_until` in the past. Trigger digest. Verify: snoozed item appears in digest alongside fresh action items.
14. **TTL cleanup — 90-day text purge, 180-day hard delete.** Insert thoughts with ages 89, 91, 179, and 181 days, with various statuses. Run TTL cleanup. Verify: 89-day text intact; 91-day text NULL, row exists; 179-day row exists (text NULL); 181-day non-`acted_on` row deleted; 181-day `acted_on` row preserved (metadata only).
15. **Invalid slash command format.** Run `/thoughtcapture schedule funday 25:00`. Verify: bot replies with usage help message.

## Automated tests to add

### Unit tests (Vitest, mocked dependencies)

| # | Test | Module | Maps to |
|---|------|--------|---------|
| U1 | Valid HMAC signature accepted | `SlackVerifier` | S-1, E-1 |
| U2 | Invalid HMAC signature rejected (HTTP 401) | `SlackVerifier` | S-1, E-1 |
| U3 | Tampered body rejected | `SlackVerifier` | S-1 |
| U4 | Missing headers rejected | `SlackVerifier` | S-1 |
| U5 | Timestamp >5 min old rejected (replay) | `SlackVerifier` | S-2 |
| U6 | Timing-safe comparison: no timing leaks (double-HMAC pattern) | `SlackVerifier` | S-1 |
| U7 | Valid LLM response parsed correctly (`action_required`, `reference`, `noise`) | `ClassificationService` | AC2 |
| U8 | Invalid LLM response defaults to `action_required` | `ClassificationService` | AC2, edge 4 |
| U9 | LLM timeout (>25s) throws, triggering Queue retry | `ClassificationService` | AC6 |
| U10 | Override text regex matches valid inputs (case-insensitive) | Override handler | AC3 |
| U11 | Override text regex rejects partial/invalid matches | Override handler | AC3 |
| U12 | Slash command parser: valid inputs ("monday 9:00", "Friday 14:30", "sunday 0:00") | Command parser | AC4 |
| U13 | Slash command parser: invalid inputs ("funday 25:00", "monday", "") | Command parser | edge 15 |
| U14 | `isDigestDue()` returns true for matching timezone/day/hour/minute window | `UserPrefsRepository` | AC4 |
| U15 | `isDigestDue()` returns false outside 15-min window | `UserPrefsRepository` | AC4 |
| U16 | `isDigestDue()` handles DST transition (spring forward / fall back) | `UserPrefsRepository` | AC4 |
| U17 | `isDigestDue()` with `America/New_York`, `America/Los_Angeles`, `Europe/London`, `Asia/Tokyo` | `UserPrefsRepository` | AC4 |
| U18 | Block Kit digest payload matches spec structure (header, sections, actions, dividers) | `DigestService` | AC4 |
| U19 | Empty-week digest message shows thought count + classification breakdown | `DigestService` | AC7 |
| U20 | Snoozed items included when `snooze_until <= now` | `DigestService` | AC5 |
| U21 | Unclassified items appear under "Needs Review" header | `DigestService` | AC6 |
| U22 | Digest items ordered by `created_at ASC` | `DigestService` | spec |
| U23 | TTL cutoff date computation: 90 days, 180 days | TTL cleanup | spec |
| U24 | Emoji mapping: `:pushpin:` → `action_required`, `:file_folder:` → `reference`, `:wastebasket:` → `noise` | Reaction handler | AC3 |
| U25 | Thought text truncation at 4,000 chars | `handleDirectMessage` | D-4 |
| U26 | Rate limit check: rejects when count > 60 in 1-hour window | `handleDirectMessage` | D-1 |
| U27 | Adversarial prompt injection text still produces valid enum classification | `ClassificationService` | T-1 |
| U28 | Error objects destructured for logging (no full error serialization) | Logging | I-1 |
| U29 | Slack URL verification challenge — POST `{"type":"url_verification","challenge":"abc123"}` → HTTP 200 with `{"challenge":"abc123"}`. No HMAC check required for this event type. | `handleSlackEvent` | Slack setup |

### Integration tests (Vitest + Miniflare, real D1)

| # | Test | Components | Maps to |
|---|------|-----------|---------|
| I1 | D1 migration applies cleanly; all tables and indexes created | D1 + migration | M1 |
| I2 | `ThoughtRepository.insert()` — thought persisted, returns correct row | Repository + D1 | AC1 |
| I3 | Idempotent insert — duplicate `slack_message_ts` silently dropped | Repository + D1 | S-2, spec |
| I4 | `ThoughtRepository.findByBotReplyTs()` — lookup by bot reply TS | Repository + D1 | AC3 |
| I5 | `ThoughtRepository.updateClassification()` — optimistic concurrency guard (`WHERE classification = 'unclassified'`) | Repository + D1 | spec |
| I6 | `ThoughtRepository.updateStatus()` — status transitions: open→acted_on, open→snoozed, open→dismissed | Repository + D1 | AC5 |
| I7 | `ThoughtRepository.purgeExpiredText()` — 90-day text purge, 180-day hard delete, `acted_on` preserved | Repository + D1 | spec, I-5 |
| I8 | `UserPrefsRepository.upsert()` + `findByUserId()` round-trip | Repository + D1 | AC4 |
| I9 | `AnalyticsRepository.logEvent()` — JSON properties round-trip | Repository + D1 | spec |
| I10 | Full `handleDirectMessage` flow — HTTP 200, thought in D1, checkmark reaction (mock Slack), Queue message enqueued | Worker + D1 + Queue | AC1 |
| I11 | `handleDirectMessage` — duplicate event dropped | Worker + D1 | S-2 |
| I12 | `handleDirectMessage` — non-text message rejected with reply | Worker | edge 1 |
| I13 | `handleDirectMessage` — unauthorized user rejected | Worker | E-2 |
| I14 | `handleDirectMessage` — feature flag disabled | Worker | rollback |
| I15 | `handleDirectMessage` — rate limit enforced at 61st thought/hour | Worker + D1 | D-1 |
| I16 | `handleDirectMessage` — text >4,000 chars truncated + notification | Worker + D1 | D-4 |
| I17 | `handleDirectMessage` — welcome message on first interaction (`welcomed = 0`) | Worker + D1 | spec |
| I18 | `handleDirectMessage` — no welcome on second interaction (`welcomed = 1`) | Worker + D1 | spec |
| I19 | Queue consumer: classification succeeds → D1 updated, Slack reply sent, `bot_reply_ts` stored | Queue + D1 + mock Slack | AC2 |
| I20 | Queue consumer: classification fails → error thrown, Queue retries | Queue + D1 + mock OpenAI | AC6 |
| I21 | Queue consumer: max retries exhausted → message in DLQ | Queue | AC6 |
| I22 | `handleClassificationOverride` — text override updates most recent thought | Worker + D1 | AC3 |
| I23 | `handleClassificationOverride` — no recent thought → error reply | Worker + D1 | edge 11 |
| I24 | `handleReactionOverride` — emoji on bot reply message updates thought via `bot_reply_ts` | Worker + D1 | AC3 |
| I25 | `handleReactionOverride` — reaction from non-owner silently ignored | Worker + D1 | E-5 |
| I26 | `handleReactionOverride` — reaction on non-thought message silently ignored | Worker + D1 | spec |
| I27 | Digest scheduler cron — enqueues eligible users to Digest Delivery Queue | Cron + D1 + Queue | AC4 |
| I28 | Digest scheduler cron — skips users with existing delivery (idempotency) | Cron + D1 | spec |
| I29 | Digest Delivery Queue consumer — generates and sends digest, records delivery | Queue + D1 + mock Slack | AC4 |
| I30 | Digest Delivery Queue consumer — empty-week message when no action items | Queue + D1 + mock Slack | AC7 |
| I31 | Digest Delivery Queue consumer — includes snoozed items due for re-delivery | Queue + D1 + mock Slack | AC5 |
| I32 | `handleDigestButtonAction` — "Acted on" updates status, Slack message updated | Worker + D1 + mock Slack | AC5 |
| I33 | `handleDigestButtonAction` — "Snooze" sets `snooze_until` to 7 days from now | Worker + D1 + mock Slack | AC5 |
| I34 | `handleDigestButtonAction` — "Dismiss" updates status | Worker + D1 + mock Slack | AC5 |
| I35 | `handleDigestButtonAction` — cross-user interaction rejected (user mismatch) | Worker + D1 | E-3, T-2 |
| I36 | `handleDigestButtonAction` — re-tap is idempotent (terminal state) | Worker + D1 | spec |
| I37 | `/thoughtcapture schedule` — valid input updates user_prefs | Worker + D1 | AC4 |
| I38 | `/thoughtcapture schedule` — invalid input returns usage help | Worker + D1 | edge 15 |
| I39 | TTL cleanup cron — purges text, deletes old records, preserves `acted_on` | Cron + D1 | spec, I-5 |
| I40a | Classification catch-up cron — 3-min-old unclassified thought NOT re-enqueued (within normal processing window) | Cron + D1 + Queue | spec |
| I40b | Classification catch-up cron — 10-min-old unclassified thought IS re-enqueued (stale, needs retry) | Cron + D1 + Queue | spec |
| I40c | Classification catch-up cron — 2-hour-old unclassified thought NOT re-enqueued (too old, likely permanent failure — left for manual review) | Cron + D1 + Queue | spec |
| I41 | `/health` endpoint — returns 200 with aggregate metrics, no sensitive data | Worker + D1 | I-3, E-6 |
| I42 | `/health` endpoint JSON schema assertion — response matches `{ status: string, total_thoughts: number, classification_counts: { action_required: number, reference: number, noise: number, unclassified: number }, override_rate_7d: number, active_users_14d: number, timestamp: string }`. Assert no extra fields. Assert no thought text or user IDs present. | Worker + D1 | I-3 |
| I43 | Invalid Slack signature → HTTP 401 on all `/slack/*` endpoints | Worker | E-1 |
| I44 | Structured log output during thought capture contains no thought text | Worker | I-1 |
| I45 | Error responses are generic (no stack traces, no D1 errors) | Worker | I-4 |
| I46 | Analytics event logged for each state change: `thought.captured`, `thought.classified`, `thought.override`, `digest.sent`, `digest.item.acted_on`, `digest.item.snoozed`, `digest.item.dismissed` | Worker + D1 | R-2, spec |
| I47 | Override rate SQL query returns correct value against seeded test data | D1 | AC8 |
| I48 | Override rate below threshold — seed 2 overrides / 14 total (14.29%), assert <15% "healthy" | D1 | AC8 |
| I49 | Override rate above threshold — seed 21 overrides / 100 total (21%), assert >20% "pause", verify alert condition fires | D1 | AC8 |
| I50 | Digest Delivery Queue batch failure isolation — batch of 5 users, mock Slack failure for user 3 only. Assert users 1/2/4/5 receive digests, user 3 message retried (not lost). Other users unaffected by partial failure. | Queue + D1 + mock Slack | AC4, AC6 |
| I51 | `digest.engagement` `time_to_first_interaction_ms` — seed `digest.sent` event at T0, then `digest.item.acted_on` at T0+5000ms. Query computes `time_to_first_interaction_ms = 5000`. No `digest.item.*` events → NULL. | D1 | spec |

### Load / performance tests (extended)

_These tests are outside the core ≤30-minute suite. Run before each milestone deploy._

| # | Test | Target | Pass criteria |
|---|------|--------|---------------|
| L1 | Digest scheduler with 100 eligible users | Cron + D1 + Queue | Completes in <5s wall time; enqueues exactly 100 messages to Digest Delivery Queue |
| L2 | Classification queue drain — 100 messages | Queue + D1 + mock OpenAI | All 100 messages processed (classified + Slack reply sent) within 120s; no DLQ messages |

### E2E tests (manual, Slack test workspace)

| # | Test | Maps to |
|---|------|---------|
| E1 | Happy path steps 1-8 above | AC1-AC7 |
| E2 | Send 5 thoughts, verify all classified, trigger digest, tap all 3 button types | AC1-AC5 |
| E3 | Override classification via emoji reaction on bot reply | AC3 |
| E4 | Change schedule via `/thoughtcapture schedule`, verify next digest at new time | AC4 |
| E5 | Unauthorized user DM — rejection message, no data persisted | E-2 |

## Regression checklist

- [ ] Thought capture: DM → ✅ reaction → classification reply (AC1, AC2)
- [ ] Override: text reply + emoji reaction both update classification (AC3)
- [ ] Digest: delivered at configured time, correct items, buttons work (AC4, AC5)
- [ ] Empty digest: summary message when no action items (AC7)
- [ ] LLM failure: thought persisted as `unclassified`, appears in digest "Needs Review" (AC6)
- [ ] Feature flag: `THOUGHT_CAPTURE_V1_ENABLED = "false"` → bot replies "temporarily unavailable"
- [ ] Allowlist: non-allowlisted user rejected, no data persisted
- [ ] Rate limit: 61st thought/hour rejected
- [ ] Text truncation: >4,000 chars truncated with notification
- [ ] TTL cleanup: 90-day text purge, 180-day delete (except `acted_on`)
- [ ] Idempotency: duplicate Slack events dropped
- [ ] Cross-user isolation: button interaction with mismatched user rejected
- [ ] HMAC verification: invalid signatures rejected with 401

## Observability checks

- **Logs show:**
  - `thought.ingested` with `thought_id`, `user_id`, `text_length` (never `text` itself)
  - `thought.classified` with `thought_id`, `classification`, `latency_ms`, `model`
  - `thought.classification_failed` with `thought_id`, `error` (destructured — message + code only)
  - `thought.overridden` with `thought_id`, `from`, `to`
  - `digest.generated` with `user_id`, `item_count`, `snoozed_count`
  - `digest.sent` with `user_id`, `slack_message_ts`
  - `digest.send_failed` with `user_id`, `error`, `retry_count`
  - `digest.button_tapped` with `thought_id`, `action`
  - `ttl.purged` with `texts_purged`, `records_deleted`
  - **Negative check:** grep all log output for thought text content — must find zero matches

- **Metrics move** (all metrics below are computed from `analytics_events` SQL queries against D1, not real-time counters or external metrics backends)**:**
  - `thoughts_captured_total` increments on each DM capture
  - `classifications_completed_total` increments after LLM classifies
  - `classification_latency_ms` histogram populated (P50 < 10s, P95 < 30s)
  - `digests_sent_total` increments on each digest delivery
  - `button_interactions_total` increments by action type
  - `override_rate_7d` computable from `analytics_events` (threshold: <15% healthy)
  - `active_users_14d` computable (users with ≥5 thoughts in trailing 14 days)
  - `digest_engagement_rate` computable (digests with ≥1 interaction / total digests)

- **Alerts configured:**
  - LLM error rate >5% over 5-minute window
  - Digest delivery failure for any user (after all retries)
  - Zero thoughts captured in 24 hours (during beta)
  - Override rate >20% over trailing 7 days
  - DLQ depth >0 (either `thought-classification-dlq` or `digest-delivery-dlq`)
  - TTL job: `texts_purged = 0` for 3 consecutive days when old thoughts exist

## AC-to-test traceability matrix

| AC | Test(s) |
|----|---------|
| AC1: DM → ✅ ack within 2s (P95) | U25, U26, I10, I11, I12, I15, I16, E1 |
| AC2: LLM classifies within 30s (P95) | U7, U8, U9, I19, I20, E1 |
| AC3: Override via text or emoji | U10, U11, U24, I22, I23, I24, I25, I26, E1, E3 |
| AC4: Weekly digest at configured time, Block Kit | U14-U18, I27-I29, I37, E1, E4 |
| AC5: Button interactions update status | U20, I31, I32, I33, I34, I35, I36, E1, E2 |
| AC6: LLM failure → `unclassified`, "Needs Review" in digest | U9, U21, I20, I21, I40a-I40c, E1 |
| AC7: Empty-week summary message | U19, I30, E1 |
| AC8: Override rate <15% (classification accuracy ≥85%) | I47, I48, I49 |
| AC9: ≥60% active users mark ≥1 "acted on" per digest week | I46 (instrumentation verified). **Not testable pre-launch;** measured over 8-week beta via: `SELECT COUNT(DISTINCT user_id) FROM analytics_events WHERE event_type = 'digest.item.acted_on' AND timestamp > datetime('now', '-7 days')` / active users. |
| AC10: LLM cost ≤$50/month for 100 users | I50c (cost calculation test: 100 users × 20 thoughts/week × 4.33 weeks × ~350 tokens × GPT-4o-mini pricing $0.15/1M input + $0.60/1M output → ~$1.30/month LLM; well within $50 budget. Asserts estimate < $50.) |

## Authz-specific tests (≥3 required)

1. **I13 / E5 — Non-allowlisted user rejected.** User not in `ENABLED_USER_IDS` sends DM → rejection message, no thought persisted, no classification triggered. (E-2 mitigation)
2. **I35 — Cross-user button interaction rejected.** User A taps a button on User B's thought → status NOT updated, warning logged. (E-3, T-2 mitigation)
3. **I25 — Cross-user emoji reaction ignored.** User A reacts to User B's bot reply → classification NOT changed, reaction silently ignored. (E-5 mitigation)
4. **I43 — Unauthenticated request rejected.** HTTP POST to any `/slack/*` endpoint without HMAC signature → HTTP 401. (E-1 mitigation)
5. **I14 — Feature flag kill switch.** `THOUGHT_CAPTURE_V1_ENABLED = "false"` → all DMs get "temporarily unavailable," no data persisted, no digests sent. (Rollback plan)

## Rollback verification (≥1 required)

1. **Feature flag rollback test (I14):** Set `THOUGHT_CAPTURE_V1_ENABLED = "false"`. Verify:
   - Bot replies to all DMs with "Thought Capture is temporarily unavailable. Your previous thoughts are saved."
   - No new thoughts are persisted to D1.
   - Digest scheduler cron exits early (no digests enqueued or sent).
   - Previously delivered digests remain visible in Slack.
   - Button interactions on existing digests return "temporarily unavailable" ephemeral message.
   - Existing thought data in D1 is retained (not deleted).
   - Set flag back to `"true"` — service resumes normally.

2. **Code rollback test (manual):** Run `wrangler rollback` to revert to previous Worker version. Verify: previous code is live, D1 data intact, service functional with old code.

## Sign-off

- [ ] CI green (`npx vitest run` — all unit + integration tests pass)
- [ ] Feature flag works (verified via I14 + rollback test)
- [ ] Rollback verified (feature flag + `wrangler rollback`)
- [ ] All 10 ACs have ≥1 mapped test (traceability matrix complete)
- [ ] ≥5 authz tests present (5 listed above)
- [ ] ≥10 edge cases documented and automated
- [ ] Observability checks confirmed (logs, metrics, alerts)
- [ ] E2E smoke test passed in Slack test workspace
