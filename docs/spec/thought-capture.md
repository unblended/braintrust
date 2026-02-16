
---
doc_type: spec
date: 20260216
owner: you
status: draft
slug: thought-capture
---

# Engineering Spec: thought-capture

## Context
Link to PRD: `docs/prd/thought-capture.md`
Link to Opportunity Brief: `docs/opportunity/20260215-thought-capture.md`

This spec defines the technical design for a Slack bot that captures fleeting thoughts from staff engineers via DM, classifies them using an LLM, and delivers weekly interactive digests. It is a greenfield system with a 4-week build timebox, operated by a single person.

**Platform:** Cloudflare Workers + D1 + Queues + Cron Triggers. Deployed via `wrangler`.

**Resolved PRD Open Questions:**
- **OQ#4 (Storage engine):** Cloudflare D1 (SQLite-based). See ADR `docs/adr/0001-storage-engine.md`.
- **PRD Critic #3 (Override rate formula):** `overrides / total_classifications` computed over a trailing 7-day window. Guardrail threshold: <15% = healthy, 15-20% = flag for prompt tuning, >20% = pause rollout.
- **PRD Critic #2 (AC5 "immediate"):** Button interactions produce a visual update within 2 seconds (P95).

## Goals / non-goals
- Goals:
  - G1: Persist every thought sent via Slack DM within 2 seconds of receipt (ack with checkmark reaction).
  - G2: Classify each thought into `action_required | reference | noise` via LLM within 30 seconds (P95).
  - G3: Deliver weekly Block Kit digest at user-configured local time with interactive disposition buttons.
  - G4: Support classification override via text reply or emoji reaction.
  - G5: Auto-delete thought text after 90 days; retain metadata only for acted-on/dismissed items.
  - G6: Keep total infrastructure cost under $75/month at 100-user scale. This breaks down as: LLM API ≤ $50/month (per PRD AC10), compute + storage + queues ≤ $25/month. At current estimates ($2/month LLM + $10/month Cloudflare paid tier), the total is ~$12/month — well within both budgets.

- Non-goals:
  - No web UI, mobile app, or dashboard.
  - No search/browse interface for past thoughts.
  - No integrations with external task trackers (Jira, Linear, etc.).
  - No rich media capture (images, voice, files).
  - No custom classification taxonomies.
  - No multi-workspace Slack app distribution (single-workspace install for beta).

## Proposed architecture (high level)

- Components:
  1. **Cloudflare Worker (HTTP handler)** — Receives all Slack webhook events (DMs, button interactions, slash commands) via HTTP. Verifies Slack request signatures (HMAC-SHA256). Persists thoughts to D1. Produces messages to the classification Queue. Sends outbound Slack API calls via `@slack/web-api` (validated for Workers compatibility in M1; fallback: raw `fetch` wrappers).
  2. **Cloudflare Queue (Classification Queue)** — Durable async queue. Receives thought IDs from the HTTP handler. Queue consumer fetches thought text from D1, calls OpenAI API for classification, writes result back to D1, and sends the classification reply to the user via Slack.
  3. **Cloudflare Queue (Digest Delivery Queue)** — Durable async queue for digest fan-out. The Digest Scheduler Cron enqueues one `{ userId, periodStart, periodEnd }` message per eligible user. The queue consumer generates and sends each user's Block Kit digest independently. This ensures digest delivery scales linearly without hitting Cron Trigger wall-clock limits.
  4. **Cron Trigger: Digest Scheduler** — Runs every 15 minutes. Queries D1 for users whose local time matches their configured digest schedule. For each eligible user, enqueues a message to the Digest Delivery Queue (fast — no Slack API calls in the cron itself).
  5. **Cron Trigger: TTL Cleanup** — Runs daily at 03:00 UTC. Purges thought text older than 90 days. Hard-deletes records older than 180 days (except `acted_on`). Purges old analytics events.
  6. **Cloudflare D1** — SQLite-based managed database. Stores thoughts, user preferences, digest state, and analytics events. Accessed via Worker binding (`env.DB`).

> **`@slack/web-api` Workers compatibility:** The `@slack/web-api` package (`WebClient`) uses `fetch` internally for HTTP calls, which is available in the Workers runtime. However, it may import Node.js-specific modules (e.g., `node:fs` for file uploads, `node:https` for HTTP) that are not available in Workers. **Validation is required in M1 (Day 1):** import `WebClient`, make a `chat.postMessage` call from `wrangler dev --local`. If it fails due to Node.js imports, use the **fallback**: a thin `SlackClient` wrapper (~50 lines) around raw `fetch` calls to the Slack Web API (`https://slack.com/api/chat.postMessage`, etc.) with `Authorization: Bearer ${token}` headers. This fallback is straightforward because we only use 5 Slack API methods: `chat.postMessage`, `chat.update`, `reactions.add`, `conversations.open`, and `users.info`.

- Data flows:
  ```
  User DM --> Slack Events API --> Worker (HTTP handler: ack + persist thought to D1)
                                        |
                                        +--> Classification Queue (enqueue thought_id)
                                                    |
                                                    +--> Queue Consumer --> OpenAI API --> D1 update + Slack reply

  Cron (every 15 min) --> Worker (digest scheduler) --> D1 query (due users)
                                                    --> Digest Delivery Queue (enqueue per-user messages)
                                                              |
                                                              +--> Queue Consumer --> D1 query (action items)
                                                                                  --> Slack Block Kit message --> User DM
                                                                                  --> D1 insert (delivery record)

  User button tap --> Slack Interactivity --> Worker (HTTP handler) --> D1 update (status change)
                                                                   --> Slack message update (visual ack)
  ```

- Key abstractions:
  - `ThoughtRepository` — CRUD + query operations for thoughts table. All queries use D1 binding (`env.DB`).
  - `UserPrefsRepository` — CRUD for user preferences. `findUsersDueForDigest()` fetches all user prefs and filters by timezone-computed eligibility in TypeScript.
  - `ClassificationService` — Encapsulates LLM prompt, model selection, retry logic. Returns `{ category, confidence }`. Uses `openai` SDK with `fetch` (Workers-compatible).
  - `DigestService` — Queries pending items, builds Block Kit payload, sends via `@slack/web-api` or `SlackClient` fallback, records delivery. Used by the Digest Delivery Queue consumer (not the cron directly).
  - `SlackClient` — Wraps outbound Slack API calls. Primary implementation: `@slack/web-api` `WebClient`. Fallback (if `WebClient` fails in Workers): thin wrapper around `fetch` calls to `https://slack.com/api/*` with bearer token auth. Exposes: `postMessage()`, `updateMessage()`, `addReaction()`, `openConversation()`, `getUserInfo()`.
  - `SlackVerifier` — Verifies Slack request signatures (HMAC-SHA256) using Web Crypto API (`crypto.subtle`). Uses timing-safe double-HMAC comparison.
  - `FeatureFlag` — Env-var-based flags defined in `wrangler.toml` (`THOUGHT_CAPTURE_V1_ENABLED`). Per-user overrides via `ENABLED_USER_IDS` env var (comma-separated).

## Data model

### Entities / tables

#### `thoughts`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `TEXT` | PK | `crypto.randomUUID()` generated in app code. Immutable. |
| `slack_user_id` | `TEXT` | NOT NULL, indexed | Slack's user ID (e.g., `U0123ABCDEF`) |
| `slack_message_ts` | `TEXT` | NOT NULL, UNIQUE | Slack message timestamp — natural idempotency key |
| `text` | `TEXT` | nullable | Nullable because text is purged after 90 days |
| `classification` | `TEXT` | NOT NULL, default `'unclassified'` | Enum: `unclassified`, `action_required`, `reference`, `noise` |
| `classification_source` | `TEXT` | NOT NULL, default `'pending'` | Enum: `pending`, `llm`, `user_override` |
| `classification_model` | `TEXT` | nullable | e.g., `gpt-4o-mini-2024-07-18` |
| `classification_latency_ms` | `INTEGER` | nullable | Time from thought receipt to classification complete |
| `status` | `TEXT` | NOT NULL, default `'open'` | Enum: `open`, `acted_on`, `snoozed`, `dismissed` |
| `snooze_until` | `TEXT` | nullable | ISO 8601 datetime. When snoozed, the date it should reappear. |
| `created_at` | `TEXT` | NOT NULL | ISO 8601 datetime, generated in app code |
| `classified_at` | `TEXT` | nullable | ISO 8601 datetime. When classification completed. |
| `status_changed_at` | `TEXT` | nullable | ISO 8601 datetime. When status last changed. |
| `text_purged_at` | `TEXT` | nullable | ISO 8601 datetime. When text was set to NULL by TTL job. |
| `bot_reply_ts` | `TEXT` | nullable | Slack message TS of the bot's classification reply. Used for emoji reaction override lookup. |

- **Invariants:**
  - `classification` is always one of the four enum values.
  - `status` is always one of the four enum values.
  - `slack_message_ts` is unique — guarantees idempotent processing of duplicate Slack events.
  - If `text_purged_at` is NOT NULL, then `text` must be NULL.
  - `created_at` is immutable.
  - All timestamps are ISO 8601 strings in UTC (e.g., `2026-02-16T14:30:00.000Z`).

- **Indexing:**
  - `idx_thoughts_user_classification_status` on `(slack_user_id, classification, status)` — digest query.
  - `idx_thoughts_user_created` on `(slack_user_id, created_at)` — recent thoughts per user (SQLite sorts ASC by default; query uses `ORDER BY created_at DESC`).
  - `idx_thoughts_created_at` on `(created_at)` — TTL cleanup query.
  - `idx_thoughts_snooze_until` on `(snooze_until)` — snoozed items due for re-delivery. No partial index in SQLite; query adds `AND status = 'snoozed'` filter.
  - `idx_thoughts_bot_reply_ts` on `(bot_reply_ts)` — emoji reaction override lookup (reaction is on the bot's reply message).
  - UNIQUE on `(slack_message_ts)` — idempotency.

#### `user_prefs`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `slack_user_id` | `TEXT` | PK | One row per user |
| `digest_day` | `INTEGER` | NOT NULL, default `1` | 0=Sunday, 1=Monday, ..., 6=Saturday |
| `digest_hour` | `INTEGER` | NOT NULL, default `9` | 0-23, in user's local timezone |
| `digest_minute` | `INTEGER` | NOT NULL, default `0` | 0-59 |
| `timezone` | `TEXT` | NOT NULL, default `'America/New_York'` | IANA timezone name, fetched from Slack on first interaction |
| `welcomed` | `INTEGER` | NOT NULL, default `0` | 0=false, 1=true. Whether the welcome message has been sent. |
| `created_at` | `TEXT` | NOT NULL | ISO 8601 datetime |
| `updated_at` | `TEXT` | NOT NULL | ISO 8601 datetime |

- **Invariants:**
  - `digest_day` is 0-6.
  - `digest_hour` is 0-23.
  - `digest_minute` is 0-59.
  - `timezone` is a valid IANA timezone name.
  - `welcomed` is 0 or 1 (SQLite has no native BOOLEAN).

- **Indexing:**
  - PK on `slack_user_id` (implicit).
  - `idx_user_prefs_digest_schedule` on `(digest_day, digest_hour, digest_minute)` — scheduler query (pre-filter before timezone computation).

#### `digest_deliveries`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `TEXT` | PK | `crypto.randomUUID()` generated in app code |
| `slack_user_id` | `TEXT` | NOT NULL, indexed | |
| `delivered_at` | `TEXT` | NOT NULL | ISO 8601 datetime. When the digest was sent. |
| `item_count` | `INTEGER` | NOT NULL | Number of action items in digest |
| `snoozed_item_count` | `INTEGER` | NOT NULL, default `0` | Number of snoozed items re-included |
| `slack_message_ts` | `TEXT` | nullable | Message TS for updating the message later |
| `period_start` | `TEXT` | NOT NULL | ISO 8601 datetime. Start of the digest period. |
| `period_end` | `TEXT` | NOT NULL | ISO 8601 datetime. End of the digest period. |

- **Invariants:**
  - One delivery per user per digest period (enforced by application logic + unique on `(slack_user_id, period_start)`).

- **Indexing:**
  - `idx_digest_deliveries_user_period` UNIQUE on `(slack_user_id, period_start)` — prevents duplicate digest delivery.

#### `analytics_events`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `TEXT` | PK | `crypto.randomUUID()` generated in app code |
| `event_type` | `TEXT` | NOT NULL | e.g., `thought.captured`, `thought.classified`, `digest.sent` |
| `slack_user_id` | `TEXT` | NOT NULL | |
| `properties` | `TEXT` | NOT NULL, default `'{}'` | JSON string. Event-specific properties. |
| `created_at` | `TEXT` | NOT NULL | ISO 8601 datetime |

- **Invariants:** None beyond NOT NULLs. This is an append-only log.
- **Indexing:**
  - `idx_analytics_events_type_created` on `(event_type, created_at)` — for querying event funnels.
  - `idx_analytics_events_user_created` on `(slack_user_id, created_at)` — for per-user queries.

### State Machine: Thought Lifecycle

```
                        +----------------+
        DM received --> | unclassified   |
                        +-------+--------+
                                | LLM classifies (or user overrides)
                                v
                        +----------------+
                        |     open       | (classification = action_required | reference | noise)
                        +--+----+----+---+
                           |    |    |
            "Acted on" ----+    |    +---- "Dismiss"
                                |
                           "Snooze"
                                |
                        +-------v--------+
                        |   snoozed      |---- next digest --> back to "open" in digest
                        +----------------+
                                |
                      (user acts on snoozed item)
                                |
                        +-------v--------+         +----------------+
                        |   acted_on     |         |  dismissed     |
                        +----------------+         +----------------+
                         (terminal)                 (terminal)
```

- **States:** `unclassified` -> `open` -> `acted_on | snoozed | dismissed`. Snoozed can return to `open` (via digest inclusion) or transition to `acted_on | dismissed`.
- **Terminal states:** `acted_on`, `dismissed`. No transitions out.
- **Guard:** Only `action_required` and `snoozed` items appear in digests. `reference` and `noise` items stay in `open` but are not surfaced.

### Migrations

- **Strategy:** Use D1's native migration system (`wrangler d1 migrations`). Migrations are SQL files in a `migrations/` directory, named sequentially (e.g., `0001_initial_schema.sql`). Each migration runs once and is tracked by D1 in an internal `d1_migrations` table.
- **V1 Migration (`0001_initial_schema.sql`):** Creates all four tables, indexes, and constraints defined above. Example:
  ```sql
  CREATE TABLE IF NOT EXISTS thoughts (
    id TEXT PRIMARY KEY,
    slack_user_id TEXT NOT NULL,
    slack_message_ts TEXT NOT NULL UNIQUE,
    text TEXT,
    classification TEXT NOT NULL DEFAULT 'unclassified',
    classification_source TEXT NOT NULL DEFAULT 'pending',
    classification_model TEXT,
    classification_latency_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    snooze_until TEXT,
    created_at TEXT NOT NULL,
    classified_at TEXT,
    status_changed_at TEXT,
    text_purged_at TEXT,
    bot_reply_ts TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_thoughts_user_classification_status
    ON thoughts(slack_user_id, classification, status);
  CREATE INDEX IF NOT EXISTS idx_thoughts_user_created
    ON thoughts(slack_user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
    ON thoughts(created_at);
  CREATE INDEX IF NOT EXISTS idx_thoughts_snooze_until
    ON thoughts(snooze_until);
  CREATE INDEX IF NOT EXISTS idx_thoughts_bot_reply_ts
    ON thoughts(bot_reply_ts);

  CREATE TABLE IF NOT EXISTS user_prefs (
    slack_user_id TEXT PRIMARY KEY,
    digest_day INTEGER NOT NULL DEFAULT 1,
    digest_hour INTEGER NOT NULL DEFAULT 9,
    digest_minute INTEGER NOT NULL DEFAULT 0,
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    welcomed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_prefs_digest_schedule
    ON user_prefs(digest_day, digest_hour, digest_minute);

  CREATE TABLE IF NOT EXISTS digest_deliveries (
    id TEXT PRIMARY KEY,
    slack_user_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    snoozed_item_count INTEGER NOT NULL DEFAULT 0,
    slack_message_ts TEXT,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_deliveries_user_period
    ON digest_deliveries(slack_user_id, period_start);

  CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    properties TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created
    ON analytics_events(event_type, created_at);
  CREATE INDEX IF NOT EXISTS idx_analytics_events_user_created
    ON analytics_events(slack_user_id, created_at);
  ```
- **Applying migrations:**
  - Local: `wrangler d1 migrations apply thought-capture-db --local`
  - Production: `wrangler d1 migrations apply thought-capture-db --remote`
- **Backward compatibility:** N/A for V1 (greenfield). For future schema changes: all migrations must be backward-compatible with the currently deployed application code (expand-then-contract pattern). D1 migrations are forward-only (no built-in `down` migration). To roll back a schema change, create a new migration that reverses the change.
- **Rollback strategy:** For V1, rollback = drop all tables (acceptable because data is not precious during beta). For post-V1 migrations: use additive changes only (add columns as nullable, add tables; never drop columns in the `up` migration). If a migration must be reversed, deploy a new forward migration that undoes the change.

## API design

This system does not expose a traditional REST API. All interactions flow through Slack's Events API and Interactivity endpoints. The Worker receives HTTP POST requests from Slack, verifies the signature, routes to the appropriate handler, and responds.

### Slack Signature Verification

Every inbound request from Slack is verified using HMAC-SHA256 before processing:

```typescript
async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): Promise<boolean> {
  const fiveMinAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinAgo) return false; // Replay attack protection

  const baseString = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString));
  const computed = 'v0=' + [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');

  // Timing-safe comparison: use double-HMAC pattern to avoid timing side-channels.
  // Comparing HMAC(key, computed) === HMAC(key, signature) is constant-time because
  // crypto.subtle operations don't leak timing info about the comparison inputs.
  const encoder = new TextEncoder();
  const [hmacComputed, hmacExpected] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(computed)),
    crypto.subtle.sign('HMAC', key, encoder.encode(signature)),
  ]);
  const a = new Uint8Array(hmacComputed);
  const b = new Uint8Array(hmacExpected);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
```

> **Security note:** Direct string comparison (`computed === signature`) is timing-unsafe — an attacker could use response timing differences to guess the signature byte-by-byte. The double-HMAC pattern above ensures constant-time comparison: both inputs are HMAC'd with the same key, then compared byte-by-byte using bitwise OR accumulation. This is the recommended approach when `crypto.subtle.timingSafeEqual` is not available in the Workers runtime.

### Worker Entry Point (Router)

The Worker `fetch` handler routes requests based on path and Slack payload type:

- `POST /slack/events` — Slack Events API (DMs, reactions). Handles URL verification challenge.
- `POST /slack/interactions` — Slack Block Kit interactions (button taps).
- `POST /slack/commands` — Slack slash commands.
- `GET /health` — Health check endpoint (no Slack verification).

The Worker also exports a `queue` handler for Queue consumers (classification and digest delivery) and a `scheduled` handler for Cron Triggers. The `scheduled` handler dispatches based on `event.cron`:

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // HTTP routing logic (see below)
  },

  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    // Dispatch by queue name
    switch (batch.queue) {
      case 'thought-classification':
        await handleClassificationBatch(batch, env);
        break;
      case 'digest-delivery':
        await handleDigestDeliveryBatch(batch, env);
        break;
      default:
        console.error(`Unknown queue: ${batch.queue}`);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case '*/15 * * * *':
        // Digest scheduler — enqueue eligible users to Digest Delivery Queue
        await scheduleDigests(env);
        break;
      case '0 3 * * *':
        // TTL cleanup — purge expired thoughts and analytics events
        await purgeExpiredThoughts(env);
        break;
      case '*/5 * * * *':
        // Classification catch-up — re-enqueue stale unclassified thoughts
        await catchUpUnclassified(env);
        break;
      default:
        console.error(`Unknown cron pattern: ${event.cron}`);
    }
  },
};
```

### Endpoints / operations

#### 1. Slack Event: `message.im` (Thought Capture)

Triggered when a user sends a DM to the bot.

- **Operation name:** `handleDirectMessage`
- **AuthZ rules:** Only messages from users in the enabled user list (feature flag). Bot's own messages are ignored (`event.bot_id` check).
- **Inbound event (from Slack):**
  ```json
  {
    "type": "event_callback",
    "event": {
      "type": "message",
      "channel_type": "im",
      "user": "U0123ABCDEF",
      "text": "we should deprecate the v1 auth service before Q3",
      "ts": "1708012345.123456",
      "channel": "D0123GHIJKL"
    }
  }
  ```
- **Processing:**
  1. Return HTTP 200 immediately (ack Slack within 3 seconds). All subsequent work happens after the response is sent, using `ctx.waitUntil()` to keep the Worker alive.
  2. Check if `slack_message_ts` already exists in D1 (idempotency). If yes, skip.
  3. Fetch/create user prefs (including timezone from Slack `users.info` API if first interaction).
  4. If `welcomed = 0`, send welcome message and set `welcomed = 1`.
  5. Add checkmark reaction to the message via `reactions.add`.
  6. Insert thought record:
     ```sql
     INSERT INTO thoughts (id, slack_user_id, slack_message_ts, text, classification, classification_source, status, created_at)
     VALUES (?, ?, ?, ?, 'unclassified', 'pending', 'open', ?)
     ON CONFLICT (slack_message_ts) DO NOTHING;
     ```
     Where `id` = `crypto.randomUUID()` and `created_at` = `new Date().toISOString()`.
  7. Enqueue thought ID to Classification Queue: `await env.CLASSIFICATION_QUEUE.send({ thoughtId, userId })`.
- **Responses to user (via Slack API):**
  - Checkmark reaction added to original message (within 2s P95).
  - Classification reply (within 30s P95, sent by Queue consumer):
    ```
    Got it — classified as Action Required

    Reply "reclassify as reference" or "reclassify as noise" to change.
    ```
- **Errors:**
  - Non-text message (subtype `file_share`, `image`, etc.): Reply "I can only capture text thoughts right now. Try typing it out!"
  - D1 write failure: Log error, do NOT ack with checkmark (return HTTP 500 to Slack so it retries delivery).
- **Idempotency:** `slack_message_ts` UNIQUE constraint. `INSERT ... ON CONFLICT (slack_message_ts) DO NOTHING`. Duplicate events from Slack are silently dropped.

#### 2. Slack Event: `message.im` (Classification Override via Text)

Triggered when user replies with override text (e.g., "reclassify as action").

- **Operation name:** `handleClassificationOverride`
- **AuthZ rules:** Same as above — only from enabled users.
- **Trigger detection:** Message text matches regex: `/^reclassify\s+as\s+(action|reference|noise)$/i`
- **Inbound event example:**
  ```json
  {
    "event": {
      "type": "message",
      "user": "U0123ABCDEF",
      "text": "reclassify as action",
      "ts": "1708012399.654321",
      "channel": "D0123GHIJKL"
    }
  }
  ```
- **Processing:**
  1. Find the most recent thought by this user (within last 24 hours) that is not the override message itself:
     ```sql
     SELECT * FROM thoughts
     WHERE slack_user_id = ?
       AND created_at > ?
       AND slack_message_ts != ?
     ORDER BY created_at DESC
     LIMIT 1;
     ```
     Where the second `?` is `new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()`.
  2. Map the override text to a classification: `action` -> `action_required`, `reference` -> `reference`, `noise` -> `noise`.
  3. Update the thought:
     ```sql
     UPDATE thoughts
     SET classification = ?, classification_source = 'user_override', status_changed_at = ?
     WHERE id = ?;
     ```
  4. Log `thought.override` analytics event with `from_category` and `to_category`.
  5. Reply confirming the override.
- **Response to user:**
  ```
  Updated! Reclassified as Action Required (was Noise).
  ```
- **Errors:**
  - No recent thought found: Reply "I couldn't find a recent thought to reclassify. Send a new thought first!"
- **Idempotency:** Override is idempotent — re-applying the same classification is a no-op.

#### 3. Slack Event: `reaction_added` (Classification Override via Emoji)

- **Operation name:** `handleReactionOverride`
- **AuthZ rules:** Reaction must be from the thought's author (not another user).
- **Trigger detection:** Specific emoji reactions on bot messages:
  - `:pushpin:` -> `action_required`
  - `:file_folder:` -> `reference`
  - `:wastebasket:` -> `noise`
- **Inbound event:**
  ```json
  {
    "event": {
      "type": "reaction_added",
      "user": "U0123ABCDEF",
      "reaction": "pushpin",
      "item": {
        "type": "message",
        "channel": "D0123GHIJKL",
        "ts": "1708012345.123456"
      }
    }
  }
  ```
- **Processing:**
  1. Look up thought by the `item.ts` (the message the reaction was added to). The user reacts to the bot's classification reply, so we look up by `bot_reply_ts`. If not found, also try `slack_message_ts` (in case the user reacts to their own original message):
     ```sql
     SELECT * FROM thoughts WHERE bot_reply_ts = ?
     UNION ALL
     SELECT * FROM thoughts WHERE slack_message_ts = ?
     LIMIT 1;
     ```
     If no thought is found, silently ignore the reaction (it's on a non-thought message).
  2. Verify the reacting user (`event.user`) matches the thought's `slack_user_id`. If not, silently ignore (another user reacted).
  3. Map the emoji to a classification: `:pushpin:` -> `action_required`, `:file_folder:` -> `reference`, `:wastebasket:` -> `noise`.
  4. Update classification and source as in text override.
  5. Log analytics event.
- **Errors:**
  - Reaction on a non-thought message: silently ignore.
- **Idempotency:** Same as text override — re-applying same classification is a no-op.

#### 4. Slack Slash Command: `/thoughtcapture schedule`

- **Operation name:** `handleScheduleCommand`
- **AuthZ rules:** Only the invoking user can modify their own schedule.
- **Inbound payload:**
  ```json
  {
    "command": "/thoughtcapture",
    "text": "schedule monday 9:00",
    "user_id": "U0123ABCDEF"
  }
  ```
- **Parsing:** Text is parsed as `schedule <day> <HH:MM>`. Day is case-insensitive day name. Time is 24-hour format.
- **Processing:**
  1. Parse day and time. Validate ranges.
  2. Upsert `user_prefs` with new `digest_day`, `digest_hour`, `digest_minute`:
     ```sql
     INSERT INTO user_prefs (slack_user_id, digest_day, digest_hour, digest_minute, timezone, welcomed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (slack_user_id)
     DO UPDATE SET digest_day = ?, digest_hour = ?, digest_minute = ?, updated_at = ?;
     ```
  3. Reply with confirmation.
- **Response:**
  ```
  Digest schedule updated: Monday at 9:00 AM (America/Los_Angeles).
  ```
- **Errors:**
  - Invalid format: Reply "Usage: /thoughtcapture schedule <day> <HH:MM>. Example: /thoughtcapture schedule friday 14:00"
- **Idempotency:** Upsert is naturally idempotent.

#### 5. Slack Block Kit Interaction: Digest Button Tap

- **Operation name:** `handleDigestButtonAction`
- **AuthZ rules:** Only the digest recipient can interact with their own digest buttons.
- **Inbound payload (from Slack interactivity):**
  ```json
  {
    "type": "block_actions",
    "user": { "id": "U0123ABCDEF" },
    "actions": [
      {
        "action_id": "thought_acted_on",
        "block_id": "thought_abc123",
        "value": "abc123-def456-..."
      }
    ],
    "message": {
      "ts": "1708099999.111111"
    }
  }
  ```
  - `action_id` is one of: `thought_acted_on`, `thought_snooze`, `thought_dismiss`.
  - `value` is the thought's UUID.
- **Processing:**
  1. Look up thought by UUID. Verify `slack_user_id` matches the interacting user.
  2. Compute `now` as `new Date().toISOString()`.
  3. Update `status` based on action:
     - `thought_acted_on`:
       ```sql
       UPDATE thoughts SET status = 'acted_on', status_changed_at = ? WHERE id = ?;
       ```
     - `thought_snooze`:
       ```sql
       UPDATE thoughts SET status = 'snoozed', snooze_until = ?, status_changed_at = ? WHERE id = ?;
       ```
       Where `snooze_until` = `new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()`.
     - `thought_dismiss`:
       ```sql
       UPDATE thoughts SET status = 'dismissed', status_changed_at = ? WHERE id = ?;
       ```
  4. Log analytics event (`digest.item.acted_on`, `digest.item.snoozed`, or `digest.item.dismissed`).
  5. Update the Slack message to show the new status (replace button section with status text).
- **Response (Slack message update):**
  The original digest message is updated via `chat.update`. The specific item's button row is replaced with:
  ```
  Marked as acted on
  ```
  or
  ```
  Snoozed until Mar 3
  ```
  or
  ```
  Dismissed
  ```
- **Errors:**
  - Thought not found or user mismatch: Log warning, respond with ephemeral "Something went wrong. Please try again."
  - Thought already in terminal state: Silently accept (idempotent). No error to user.
- **Idempotency:** Re-tapping the same button is a no-op (status is already set). The message update is idempotent.

#### 6. Internal: Digest Generation (Cron Trigger + Digest Delivery Queue)

- **Operation name:** `scheduleDigests` (Cron) + `deliverDigest` (Queue consumer)
- **Trigger:** Cron Trigger runs every 15 minutes (defined in `wrangler.toml`: `crons = ["*/15 * * * *"]`).
- **Processing (Cron — `scheduleDigests`):**
  1. Compute `now` as `new Date()`.
  2. Query all user preferences:
     ```sql
     SELECT slack_user_id, digest_day, digest_hour, digest_minute, timezone
     FROM user_prefs;
     ```
  3. For each user, compute their current local time using `Intl.DateTimeFormat` (see `isDigestDue()` function below).
  4. For each due user, check if a delivery already exists for this period:
     ```sql
     SELECT 1 FROM digest_deliveries
     WHERE slack_user_id = ? AND period_start = ?;
     ```
     Where `period_start` is computed as the start of the current week in the user's timezone.
  5. For each due user without a delivery, enqueue a message to the Digest Delivery Queue:
     ```typescript
     await env.DIGEST_DELIVERY_QUEUE.send({ userId, periodStart, periodEnd });
     ```
     This keeps the Cron handler lightweight — no Slack API calls, no heavy queries.

- **`isDigestDue()` function:**
  ```typescript
  function isDigestDue(prefs: UserPrefs, now: Date): boolean {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: prefs.timezone,
      weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
    });
    const parts = formatter.formatToParts(now);
    const localDay = getDayNumber(parts.find(p => p.type === 'weekday')!.value); // 0-6
    const localHour = parseInt(parts.find(p => p.type === 'hour')!.value);
    const localMinute = parseInt(parts.find(p => p.type === 'minute')!.value);

    return localDay === prefs.digest_day
      && localHour === prefs.digest_hour
      && localMinute >= prefs.digest_minute
      && localMinute < prefs.digest_minute + 15;
  }
  ```

- **Processing (Queue consumer — `deliverDigest`):**
  1. Receive `{ userId, periodStart, periodEnd }` from Digest Delivery Queue.
  2. Re-check delivery idempotency (another cron run may have already enqueued a duplicate):
     ```sql
     SELECT 1 FROM digest_deliveries
     WHERE slack_user_id = ? AND period_start = ?;
     ```
     If delivery exists, ack the message and return.
  3. Query action items for this user:
     ```sql
     SELECT * FROM thoughts
     WHERE slack_user_id = ?
       AND (
         (classification = 'action_required' AND status = 'open'
          AND created_at >= ? AND created_at < ?)
         OR (status = 'snoozed' AND snooze_until <= ?)
         OR (classification = 'unclassified' AND status = 'open')
       )
     ORDER BY created_at ASC;
     ```
     Where the bind parameters are the period start/end timestamps and current ISO timestamp.
  4. Open DM channel with user via `conversations.open` (to get the DM channel ID for `chat.postMessage`).
  5. Build Block Kit message (see Digest Block Kit Layout below).
  6. Send via `chat.postMessage`. Record delivery in `digest_deliveries`.
  7. Log `digest.sent` analytics event.
  8. On failure, throw error — Cloudflare Queues will retry (up to 3 times). Failed deliveries are retried independently per user — one user's failure doesn't block others.

- **Digest Block Kit Layout:**
  ```json
  {
    "blocks": [
      {
        "type": "header",
        "text": { "type": "plain_text", "text": "Your Action Items This Week (5 items)" }
      },
      {
        "type": "section",
        "block_id": "thought_abc123",
        "text": {
          "type": "mrkdwn",
          "text": "*we should deprecate the v1 auth service before Q3*\n_Captured Feb 15 at 2:30 PM_"
        }
      },
      {
        "type": "actions",
        "block_id": "actions_abc123",
        "elements": [
          { "type": "button", "text": { "type": "plain_text", "text": "Acted on" }, "action_id": "thought_acted_on", "value": "abc123-..." },
          { "type": "button", "text": { "type": "plain_text", "text": "Snooze" }, "action_id": "thought_snooze", "value": "abc123-..." },
          { "type": "button", "text": { "type": "plain_text", "text": "Dismiss" }, "action_id": "thought_dismiss", "value": "abc123-..." }
        ]
      },
      { "type": "divider" }
    ]
  }
  ```

- **Empty-week message:**
  ```json
  {
    "blocks": [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "No action items this week. You captured 12 thoughts — 3 Reference, 9 Noise. Keep capturing!"
        }
      }
    ]
  }
  ```

#### 7. Internal: TTL Cleanup (Cron Trigger — Daily)

- **Operation name:** `purgeExpiredThoughts`
- **Trigger:** Cron Trigger runs daily at 03:00 UTC (defined in `wrangler.toml`: `crons = ["0 3 * * *"]`).
- **Processing:**
  ```sql
  -- Purge text for thoughts older than 90 days (keep metadata for acted-on/dismissed)
  UPDATE thoughts
  SET text = NULL, text_purged_at = ?
  WHERE created_at < ?
    AND text IS NOT NULL;

  -- Hard-delete thoughts older than 180 days that are not acted_on
  DELETE FROM thoughts
  WHERE created_at < ?
    AND status != 'acted_on';

  -- Purge old analytics events (retain 180 days)
  DELETE FROM analytics_events
  WHERE created_at < ?;
  ```
  Where the bind parameters are:
  - `text_purged_at`: `new Date().toISOString()`
  - 90-day cutoff: `new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()`
  - 180-day cutoff: `new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()`

#### 8. Queue Consumer: Classification Worker

- **Operation name:** `classifyThought`
- **Trigger:** Cloudflare Queue consumer. Messages are enqueued by `handleDirectMessage` with payload `{ thoughtId, userId }`.
- **Queue configuration (in `wrangler.toml`):**
  ```toml
  [[queues.producers]]
  queue = "thought-classification"
  binding = "CLASSIFICATION_QUEUE"

  [[queues.consumers]]
  queue = "thought-classification"
  max_batch_size = 1
  max_retries = 3
  dead_letter_queue = "thought-classification-dlq"
  ```
- **Processing:**
  1. Fetch thought text from D1:
     ```sql
     SELECT id, text, created_at FROM thoughts WHERE id = ?;
     ```
  2. Call OpenAI API with classification prompt:
     ```
     System: You are a thought classifier for a staff engineer's personal capture system.
     Classify the following thought into exactly one category.

     Categories:
     - action_required: The thought describes something the user should DO — write a doc,
       follow up with someone, investigate a problem, propose a change, file a bug, etc.
     - reference: The thought is an observation, insight, or piece of information worth
       remembering but doesn't require immediate action — a pattern noticed, a fact learned,
       a link to revisit.
     - noise: The thought is ephemeral, context-dependent, already resolved, or too vague
       to be useful later — "meeting went long," "ugh builds are slow today," "need coffee."

     Respond with ONLY the category name (action_required, reference, or noise). Nothing else.

     User: <thought text>
     ```
  3. Parse response. If response is not one of the three valid categories, default to `action_required` (fail safe — better to surface than to lose).
  4. Compute latency: `Date.now() - new Date(thought.created_at).getTime()`.
  5. Update thought record:
     ```sql
     UPDATE thoughts
     SET classification = ?, classification_source = 'llm',
         classification_model = ?, classification_latency_ms = ?, classified_at = ?
     WHERE id = ? AND classification = 'unclassified';
     ```
  6. Send classification reply to user via Slack `chat.postMessage`. Capture the reply's `ts` from the API response.
  7. Store the bot reply TS for emoji reaction lookups:
     ```sql
     UPDATE thoughts SET bot_reply_ts = ? WHERE id = ?;
     ```
  8. Log `thought.classified` analytics event.

- **Retry logic:** Cloudflare Queues handle retries natively. If the consumer throws an error (e.g., OpenAI API timeout), the message is retried up to `max_retries` (3) times with automatic backoff. After exhaustion, the message goes to the dead-letter queue (`thought-classification-dlq`).
- **Fallback:** A Cron Trigger (every 5 minutes) runs a catch-up query for unclassified thoughts older than 5 minutes, re-enqueuing them to the classification queue:
  ```sql
  SELECT id, slack_user_id FROM thoughts
  WHERE classification = 'unclassified'
    AND created_at < ?
    AND created_at > ?;
  ```
  Where the bind parameters are 5-minutes-ago and 1-hour-ago timestamps. This handles edge cases where queue messages are lost or the DLQ fills up.

## Consistency & concurrency

- **Conflict resolution rules:**
  - Thought persistence is idempotent via `slack_message_ts` UNIQUE constraint. `INSERT INTO thoughts (...) VALUES (...) ON CONFLICT (slack_message_ts) DO NOTHING`.
  - Classification updates use optimistic concurrency: `UPDATE thoughts SET classification = ? WHERE id = ? AND classification = 'unclassified'`. If the row was already classified (e.g., by a retry or user override), the update affects zero rows — a safe no-op.
  - Status updates from button taps are last-write-wins, which is acceptable because only one user can interact with their own thoughts.

- **Ordering guarantees:**
  - Thoughts are ordered by `created_at` (which is `new Date().toISOString()` at insert time, not Slack's `ts`). This ensures DB ordering matches real-world ordering.
  - Digest items are ordered by `created_at ASC` (oldest first).
  - Classification may complete out of order (thought B classified before thought A). This is acceptable — classification order doesn't affect user experience.
  - D1 is single-writer — concurrent writes are serialized. This eliminates write-write conflicts entirely at our scale.

- **Retries and idempotency keys:**
  - Slack event delivery: idempotent via `slack_message_ts` UNIQUE.
  - Digest delivery: idempotent via `UNIQUE(slack_user_id, period_start)` on `digest_deliveries`.
  - OpenAI API calls: not idempotent (no idempotency key support), but classification is a pure function — retrying with the same input produces equivalent output.
  - Button interactions: idempotent — re-setting the same status is a no-op.
  - Queue message delivery: Cloudflare Queues provide at-least-once delivery. The classification update's `WHERE classification = 'unclassified'` guard ensures idempotent processing.

## Failure modes (top 7)

1. **LLM API failure (timeout, 5xx, rate limit)**
   - Impact: Thought persists but stays `unclassified`. User doesn't get classification reply.
   - Mitigation: Cloudflare Queue retries up to 3 times with automatic backoff. After exhaustion, message goes to dead-letter queue. Catch-up Cron (every 5 min) re-enqueues stale unclassified thoughts. Alert fires if error rate >5% over 5-minute window.
   - Recovery: Unclassified thoughts can be batch-reclassified with a one-off script when API recovers. DLQ messages can be replayed.

2. **D1 unavailable (Cloudflare outage)**
   - Impact: Thoughts cannot be persisted. Slack ack (checkmark) is NOT sent — Slack will retry event delivery (3 times over ~30 minutes).
   - Mitigation: Return HTTP 500 to Slack's event delivery to trigger automatic retry. Log error with structured logging. D1 has automatic replication and Cloudflare's SLA applies.
   - Recovery: Slack retries handle transient D1 outages. For extended outages (>30 min), thoughts are lost. Acceptable for beta — users can re-send.

3. **Slack API failure (rate limit, 5xx) during digest delivery**
   - Impact: Digest not delivered to one or more users.
   - Mitigation: Digest delivery retries on next Cron Trigger run (15 minutes later). Each delivery is wrapped in a try/catch — failure for one user does not block others. Failed deliveries are logged and the `digest_deliveries` row is NOT inserted, so the next cron run will re-attempt.
   - Recovery: Cron runs every 15 minutes. Undelivered digests will be retried on next run. If all retries fail within the day, alert fires and manual investigation is needed.

4. **Duplicate Slack event delivery**
   - Impact: Without protection, a thought could be persisted twice.
   - Mitigation: `slack_message_ts` UNIQUE constraint. `INSERT ... ON CONFLICT DO NOTHING`. Duplicate events are silently dropped. This is Slack's documented behavior — events may be delivered more than once.
   - Recovery: N/A — fully automatic.

5. **Classification returns invalid value**
   - Impact: LLM returns unexpected text instead of one of the three valid categories.
   - Mitigation: Response is validated against the enum `['action_required', 'reference', 'noise']`. If invalid, default to `action_required` (fail safe — surface rather than lose). Log a warning with the raw LLM response for debugging.
   - Recovery: Automatic. User can override if the default classification is wrong.

6. **Worker CPU time limit exceeded (30 seconds)**
   - Impact: Worker invocation is terminated by Cloudflare. Partial work may be lost.
   - Mitigation: The only CPU-intensive operation (LLM classification) runs in the Queue consumer, not in the HTTP handler. HTTP handlers do minimal work: signature verification, D1 insert, queue enqueue — well under 10ms CPU time. Queue consumers have a 15-minute execution limit. Cron Triggers have a 30-second limit; the digest cron only queries D1 for eligible users and enqueues messages to the Digest Delivery Queue — no Slack API calls. At 100 users, this is ~100 D1 reads + ~20 queue enqueues, completing in <5 seconds. Actual digest delivery (D1 queries + Slack API calls) runs in Queue consumers with 15-minute limits.
   - Recovery: If a Cron Trigger times out (unlikely), un-enqueued users are picked up on the next cron run (15 minutes later). The idempotent delivery check prevents duplicates.

7. **Queue message loss or DLQ overflow**
   - Impact: Thought is persisted but never classified.
   - Mitigation: Catch-up Cron (every 5 minutes) queries for stale `unclassified` thoughts and re-enqueues them. This is a safety net for any queue-related failure, including DLQ overflow. DLQ messages can also be inspected and replayed manually via `wrangler queues`.
   - Recovery: Automatic via catch-up Cron. Manual replay of DLQ messages if needed.

## Security

- **Threat model link:** `docs/security/thought-capture-threat-model.md` (to be created separately)
- **Data classification:**
  - Thought text: **Confidential** — may contain proprietary technical details. Stored encrypted at rest (D1 default — Cloudflare encrypts all data at rest). Purged after 90 days.
  - Slack user IDs: **Internal** — not PII by themselves but can be correlated to identity via Slack API.
  - Analytics events: **Internal** — aggregated metrics, no thought text.
- **Secrets handling:**
  - `SLACK_BOT_TOKEN` — Stored via `wrangler secret put SLACK_BOT_TOKEN`. Accessed as `env.SLACK_BOT_TOKEN` in Worker. Never logged.
  - `SLACK_SIGNING_SECRET` — Used to verify Slack webhook signatures (HMAC-SHA256). Stored via `wrangler secret put SLACK_SIGNING_SECRET`.
  - `OPENAI_API_KEY` — Stored via `wrangler secret put OPENAI_API_KEY`. Never logged.
  - No `DATABASE_URL` needed — D1 is accessed via binding, not connection string.
  - All secrets are managed via `wrangler secret` (stored encrypted in Cloudflare's secret store). Non-secret configuration (feature flags, enabled user IDs) can be defined in `wrangler.toml` as `[vars]`.
  - No secrets in code, config files, or version control.
- **Audit logging:**
  - All state changes (classification, status change, override) are logged as `analytics_events` with timestamp and user ID.
  - Structured application logs include event type, user ID, and thought ID (never thought text in logs).
- **Input validation:**
  - Slack webhook signatures are verified on every request using HMAC-SHA256 via Web Crypto API (`crypto.subtle`). See `SlackVerifier` above.
  - Thought text is stored as-is (no sanitization needed — it's never rendered as HTML).
  - Slash command input is validated against expected format before processing.

## Performance & cost

- **What scales with users?**
  - Thought storage: ~1 KB/thought x 20 thoughts/week x 100 users = ~2 MB/week, ~8 MB/month. D1 free tier (5GB) lasts >5 years at this rate.
  - LLM API calls: Linear with thought volume. 100 users x 20 thoughts/week = 2,000 calls/week.
  - Digest delivery: Linear with users. 100 digests/week, each requiring 1-2 Slack API calls.
  - Digest query: At 100 users, the digest Cron fetches all user_prefs (100 rows), filters in-memory, then queries thoughts for eligible users — trivial.
  - Worker invocations: ~2,000 thought captures/week + ~100 digests/week + 672 cron invocations/week (15-min intervals) + button interactions. Well under 100K/day free tier.

- **Expected hot paths:**
  1. `handleDirectMessage` — called on every thought capture. Must return HTTP 200 within 3 seconds. D1 insert + Slack reaction via `ctx.waitUntil()`. Target: <500ms P95 for the full handler (ack is immediate).
  2. `classifyThought` (Queue consumer) — called async for every thought. OpenAI API latency dominates. Target: <10s P50, <30s P95.
  3. `handleDigestButtonAction` — called on every button tap. D1 update + Slack message update = 2 I/O calls. Target: <2s P95.

- **Limits/quotas:**
  - Slack rate limits: `chat.postMessage` is 1 msg/sec per channel. Digest delivery uses the Digest Delivery Queue, which processes messages sequentially with automatic backoff — at 100 users, delivery is naturally staggered across Queue consumer invocations, well within Slack rate limits.
  - OpenAI rate limits: GPT-4o-mini has generous rate limits (thousands of RPM). 2,000 calls/week = ~0.2 calls/minute average. No concern.
  - D1 free tier: 5M reads/day, 100K writes/day. Our usage: ~300 writes/day, ~1,000 reads/day. Free tier covers 50x our needs.
  - Workers free tier: 100K requests/day. Our usage: ~500 requests/day. Free tier covers 200x our needs.
  - Cloudflare Queue free tier: 1M operations/month. Our usage: ~10K operations/month.

- **Cost estimate (100 users, monthly):**
  | Component | Monthly cost |
  |-----------|-------------|
  | Cloudflare Workers (free tier) | $0 |
  | Cloudflare D1 (free tier) | $0 |
  | Cloudflare Queues (free tier) | $0 |
  | OpenAI GPT-4o-mini | ~$2 |
  | **Total (free tier)** | **~$2/month** |
  | **Total (paid tier — Workers $5 + D1 $5)** | **~$12/month** |

## Observability

- **Logs (key events):**
  - `thought.ingested` — Thought persisted to D1. Fields: `thought_id`, `user_id`, `text_length`.
  - `thought.classified` — Classification complete. Fields: `thought_id`, `classification`, `latency_ms`, `model`.
  - `thought.classification_failed` — LLM API call failed after retries (sent to DLQ). Fields: `thought_id`, `error`.
  - `thought.overridden` — User overrode classification. Fields: `thought_id`, `from`, `to`.
  - `digest.generated` — Digest built for a user. Fields: `user_id`, `item_count`, `snoozed_count`.
  - `digest.sent` — Digest delivered via Slack. Fields: `user_id`, `slack_message_ts`.
  - `digest.send_failed` — Digest delivery failed. Fields: `user_id`, `error`, `retry_count`.
  - `digest.button_tapped` — User interacted with digest button. Fields: `thought_id`, `action`.
  - `ttl.purged` — TTL job ran. Fields: `texts_purged`, `records_deleted`.
  - All logs are structured JSON via `console.log(JSON.stringify({ event, ...fields }))`. Workers Logs captures all `console.log` output. For persistent log storage, configure Workers Logpush to R2 or an external service.

- **Metrics (RED + business metrics):**
  - **Rate:** `thoughts_captured_total` (counter), `classifications_completed_total` (counter), `digests_sent_total` (counter), `button_interactions_total` (counter by action type).
  - **Errors:** `classification_errors_total` (counter), `digest_delivery_errors_total` (counter), `slack_api_errors_total` (counter by method).
  - **Duration:** `classification_latency_ms` (histogram), `digest_generation_latency_ms` (histogram), `slack_ack_latency_ms` (histogram).
  - **Business:** `override_rate_7d` (gauge — overrides / total classifications over trailing 7 days), `digest_engagement_rate` (gauge — digests with >=1 interaction / digests sent), `active_users_14d` (gauge).
  - Metrics are computed from `analytics_events` table via periodic SQL queries (no separate metrics infrastructure for V1). The `/health` endpoint queries D1 for key metrics and returns JSON. Workers Analytics Engine can be used for request-level metrics if needed.

- **Traces:** Workers Trace Events provide per-request traces including CPU time, wall time, and subrequest count. These are available in the Cloudflare dashboard and via Logpush. A `thought_id` correlation ID in structured logs ties events across HTTP handler -> Queue consumer -> Cron Trigger.

- **Alerts:**
  - **LLM error rate >5% over 5 minutes:** Classification is degraded. Check OpenAI status page. Thoughts are still captured.
  - **Digest delivery failure for any user:** Individual delivery failed all retries. Investigate Slack API issues.
  - **Zero thoughts captured in 24 hours (during beta):** Possible bot or Slack connectivity issue.
  - **Override rate >20% over 7 days:** Classification quality has degraded. Pause rollout, investigate prompt.
  - **DLQ depth >0:** Messages failed all retries. Investigate and replay.
  - Alerts are implemented via Cloudflare Notifications (available in dashboard) for Worker error rates. Business-level alerts (override rate, engagement) are computed by a daily Cron Trigger that queries `analytics_events` and posts to a monitoring Slack channel.

## Override rate formula

The override rate is the primary signal for classification quality:

```sql
-- Computed by querying analytics_events or thoughts table directly
SELECT
  CAST(SUM(CASE WHEN classification_source = 'user_override' THEN 1 ELSE 0 END) AS REAL)
  / CAST(COUNT(*) AS REAL) AS override_rate
FROM thoughts
WHERE classification != 'unclassified'
  AND classified_at > ?;
```
Where `?` is `new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()`.

- Computed daily (or on-demand via `/health` endpoint).
- Thresholds:
  - <15%: Healthy. No action.
  - 15-20%: Flag for prompt tuning. Log warning. Review recent overrides for patterns.
  - >20%: Pause rollout to new users. Alert. Investigate and revise classification prompt.

## Rollout / delivery plan

- **Feature flags:**
  - `THOUGHT_CAPTURE_V1_ENABLED` (defined in `wrangler.toml` `[vars]`, string `"true"` or `"false"`): Master kill switch. When `"false"`, bot replies to all DMs with "Thought Capture is temporarily unavailable."
  - `ENABLED_USER_IDS` (defined in `wrangler.toml` `[vars]`, comma-separated Slack user IDs): Per-user allowlist. Only users in this list can use the bot. Start with 5 dogfood users, expand to 20-30 beta users.
  - Changing feature flags: update `wrangler.toml` and `wrangler deploy`, or use `wrangler secret put` for sensitive flags. Changes take effect within seconds.

- **Backfill jobs:**
  - No backfill needed (greenfield).
  - If classification prompt changes during beta, a `reclassify-unacted` script can re-run classification on all `status = 'open'` thoughts that haven't been overridden. This script enqueues thought IDs to the classification Queue.

- **Phased rollout:**
  1. **Week 5 (Dogfood):** 5 internal users. Validate end-to-end: capture -> classify -> digest -> button interaction. Fix bugs.
  2. **Week 6-7 (Beta ramp):** Add 10-15 users per week. Monitor override rate. If >20%, pause and tune prompt.
  3. **Week 8-12 (Beta hold):** Full 20-30 user cohort. Measure primary success metric.
  4. **Week 13 (Evaluate):** Decision: expand, iterate, or kill.

- **Rollback plan:**
  1. Set `THOUGHT_CAPTURE_V1_ENABLED="false"` in `wrangler.toml` and `wrangler deploy`. Bot immediately stops processing new thoughts and digests.
  2. For code rollback: `wrangler rollback` reverts to the previous Worker version instantly.
  3. Bot replies to all DMs with: "Thought Capture is temporarily unavailable. Your previous thoughts are saved."
  4. Existing thought data is retained in D1 (not deleted on rollback).
  5. Digest Cron stops generating new digests (feature flag check at start of cron handler).
  6. Previously delivered digests remain visible in Slack but button interactions return a "temporarily unavailable" ephemeral message.
  7. To fully decommission: remove Slack app from workspace, delete D1 database (`wrangler d1 delete`).

## `wrangler.toml` configuration

```toml
name = "thought-capture"
main = "src/index.ts"
compatibility_date = "2026-02-16"

[vars]
THOUGHT_CAPTURE_V1_ENABLED = "true"
ENABLED_USER_IDS = ""

[[d1_databases]]
binding = "DB"
database_name = "thought-capture-db"
database_id = "<generated-on-create>"

[[queues.producers]]
queue = "thought-classification"
binding = "CLASSIFICATION_QUEUE"

[[queues.producers]]
queue = "digest-delivery"
binding = "DIGEST_DELIVERY_QUEUE"

[[queues.consumers]]
queue = "thought-classification"
max_batch_size = 1
max_retries = 3
dead_letter_queue = "thought-classification-dlq"

[[queues.consumers]]
queue = "digest-delivery"
max_batch_size = 5
max_retries = 3
dead_letter_queue = "digest-delivery-dlq"

[triggers]
crons = ["*/15 * * * *", "0 3 * * *", "*/5 * * * *"]
# */15 * * * *  = digest scheduler (every 15 min)
# 0 3 * * *    = TTL cleanup (daily at 03:00 UTC)
# */5 * * * *  = classification catch-up (every 5 min)
```

## Testing strategy

- **Unit:**
  - `ClassificationService`: Mock OpenAI API (mock `fetch`). Test valid response parsing, invalid response fallback, timeout handling.
  - `DigestService`: Mock D1 queries. Test Block Kit message construction, empty-week message, snoozed item inclusion, item ordering.
  - `SlackVerifier`: Test HMAC signature verification with known test vectors. Test replay attack rejection (old timestamp).
  - Slash command parser: Test valid formats, invalid formats, edge cases (midnight, Sunday, etc.).
  - Override text parser: Test regex matching, case insensitivity, partial matches.
  - `isDigestDue()` timezone function: Test with users in different timezones at known timestamps. Test DST transitions.
  - TTL cleanup date arithmetic: Test cutoff date computation for 90-day and 180-day thresholds.

- **Integration:**
  - D1 integration tests using `wrangler dev --local` with local D1 (SQLite). Alternatively, use Miniflare's D1 simulator in Vitest. Test: thought CRUD, idempotent insert, digest query, TTL purge.
  - OpenAI API integration test (live call, rate-limited to 1/test run): Verify response format and latency.
  - Slack API integration test (using Slack's test workspace): Verify message posting, reaction adding, Block Kit rendering.
  - Queue integration test: Enqueue a message, verify consumer processes it and updates D1.

- **E2E:**
  - Full flow test using a dedicated Slack test workspace:
    1. Send DM -> verify checkmark reaction -> verify classification reply.
    2. Trigger digest -> verify Block Kit message -> tap button -> verify status update.
    3. Send override reply -> verify classification change.
    4. Configure schedule via slash command -> verify schedule update.

- **Load-ish test:**
  - Simulate 100 concurrent thought captures (using Slack event replay or direct D1 inserts + queue enqueue). Verify:
    - No dropped thoughts (all persisted in D1).
    - Classification queue drains within 5 minutes.
    - No D1 write errors (single-writer serialization holds).
  - Simulate 100-user digest generation: invoke Cron Trigger and verify it enqueues 100 messages to the Digest Delivery Queue within 30-second CPU time limit. Then process all 100 Queue messages (simulating consumer invocations). Verify all digests delivered. Monitor Slack rate limit responses.

- **Testing tools:**
  - **Vitest** as test runner (Workers-compatible).
  - **Miniflare** for local Workers runtime simulation in tests (provides D1, Queues, and KV bindings).
  - **`unstable_dev`** from `wrangler` for integration tests against a local Worker instance.
  - No Docker required for any test scenario.
