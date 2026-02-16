
---
doc_type: adr
date: 20260216
owner: you
status: proposed  # proposed | accepted | deprecated | superseded
slug: storage-engine
---

# ADR: Storage Engine — Cloudflare D1 (SQLite-based)

_Supersedes previous proposal: Postgres via Neon_

## Context and Problem Statement
The Thought Capture system needs a persistent data store for thought records, user preferences, and digest state. The store must support: (1) timezone-aware scheduled queries for digest delivery at user-local times, (2) TTL-based deletion for 90-day retention policy, (3) per-user data isolation, and (4) reliable operation for a solo operator with minimal ops burden. PRD Open Question #4 explicitly calls for this decision. Total infrastructure cost (compute + storage + LLM) must stay well under $100/month for 100 beta users.

**New constraint:** The deployment platform is Cloudflare Workers (see ADR-0003). The storage engine must integrate natively with the Workers runtime.

## Decision Drivers
- Must integrate natively with Cloudflare Workers (no external network hops)
- Minimal ops burden for a solo operator (managed service, no connection pooling, no Docker)
- Free or near-free at 100-user beta scale
- Must support structured queries for digest scheduling, TTL cleanup, and idempotent inserts
- Local development must work without external dependencies

## Considered Options
- **Option A: Cloudflare D1 (SQLite-based, Cloudflare-native)**
  - Pros: Zero-network-hop access from Workers via bindings (`env.DB`). No connection pooling or TCP setup — the binding is a direct API call, not a socket. Managed by Cloudflare — automatic backups (point-in-time restore), replication, and encryption at rest. Free tier is generous: 5GB storage, 5M reads/day, 100K writes/day. Paid tier ($5/month) scales well beyond beta. Migrations supported natively via `wrangler d1 migrations`. Local development via `wrangler dev --local` uses a local SQLite file — no external dependencies. SQLite's single-writer is fine for our write volume (~2,000 writes/day at 100 users).
  - Cons: No native `TIMESTAMPTZ` — timestamps stored as ISO 8601 TEXT strings, timezone math must be done in application code. No `gen_random_uuid()` — must use `crypto.randomUUID()` in Workers. No `JSONB` — JSON stored as TEXT column with `JSON.stringify()`/`JSON.parse()`. No partial indexes (SQLite limitation) — must use regular indexes. No `AT TIME ZONE` operator — digest schedule eligibility must be computed in application code. No `INTERVAL` syntax — date arithmetic done in app code.

- **Option B: Neon Postgres (managed serverless Postgres)**
  - Pros: Native `TIMESTAMPTZ` type and `AT TIME ZONE` operations for timezone-aware digest scheduling. Rich SQL capabilities (partial indexes, JSONB, interval arithmetic). Mature ecosystem.
  - Cons: Requires network hop from Workers to external Postgres — adds latency (~50-100ms per query) and a failure mode. Needs a connection driver compatible with Workers (e.g., `@neondatabase/serverless` over WebSocket or HTTP). Connection pooling is complex in serverless. Adds an external vendor dependency outside the Cloudflare platform. Free tier is more limited (0.5GB storage, 100 compute-hours/month). More complex local dev (need local Postgres or Neon branching).

- **Option C: Cloudflare KV + Workers KV**
  - Pros: Simple key-value API. Eventually consistent reads are fast (~0ms from edge). Native to Cloudflare.
  - Cons: Eventually consistent — not suitable for data that needs immediate read-after-write (thought persistence, status updates). No relational queries — would need to maintain manual indexes. No SQL — all query logic lives in application code. Not designed for the kind of structured, queryable data this system needs.

- **Option D: Cloudflare Durable Objects**
  - Pros: Strong consistency. Per-user state isolation is natural (one DO per user). Built-in SQLite storage via Durable Objects SQL API.
  - Cons: Over-engineered for this use case — we don't need per-user isolation at the infrastructure level. Cross-user queries (e.g., "which users are due for a digest") require fan-out across all DOs. More complex programming model. Higher cost than D1 at scale.

## Decision Outcome
Chosen option: **Option A — Cloudflare D1**, because:

1. **Native integration with Workers.** D1 is accessed via bindings — no network hop, no connection pooling, no TCP setup. This is the lowest-latency, lowest-complexity storage option for a Workers-based system.
2. **Timezone math in application code is acceptable.** The digest scheduler runs every 15 minutes via Cron Trigger. It queries all user preferences (100 rows at beta scale), computes timezone eligibility in TypeScript using `Intl.DateTimeFormat` (available natively in the Workers runtime), and filters in-memory. At 100 users, this is trivial. The tradeoff vs. Postgres `AT TIME ZONE` is more application code, but it eliminates an entire external dependency.
3. **TTL deletion is straightforward in SQLite.** `DELETE FROM thoughts WHERE created_at < ?` with an app-computed cutoff date. Slightly more verbose than Postgres `INTERVAL` syntax but functionally identical.
4. **D1's free tier (5GB, 5M reads/day, 100K writes/day)** far exceeds our needs. At 100 users generating ~2,000 thoughts/week, we'll use ~8MB/month of storage and ~300 writes/day. The free tier lasts indefinitely.
5. **Single-platform simplicity.** Compute (Workers), storage (D1), queues (Queues), scheduling (Cron Triggers) all on Cloudflare. One vendor, one billing dashboard, one deployment tool (`wrangler`). This is the boring choice for a Cloudflare-native system.
6. **Local development is trivial.** `wrangler dev --local` provides a local D1 instance backed by SQLite. No Docker, no external database, no network configuration.

### Consequences
- Good, because zero network hop to storage — lowest possible query latency.
- Good, because single-platform architecture — no external database vendor dependency.
- Good, because local dev requires only `wrangler dev` — no Docker or external services.
- Good, because free tier covers beta with massive headroom; paid tier is $5/month.
- Good, because `wrangler d1 migrations` provides native migration tooling.
- Bad, because timezone-aware scheduling moves to application code (~30 lines of TypeScript instead of a SQL `WHERE` clause). Mitigated: at 100 users, in-memory filtering is trivial and the code is straightforward.
- Bad, because no partial indexes (SQLite limitation) — the snoozed-items index cannot filter by `status = 'snoozed'`. Mitigated: regular index on `snooze_until` is sufficient at this scale.
- Bad, because no `JSONB` — analytics event properties stored as TEXT. Mitigated: we never query inside the JSON; it's only read/written as a whole blob.
- Bad, because timestamps are TEXT, not a native type — application must ensure consistent ISO 8601 formatting. Mitigated: a single `toISO()` helper function used everywhere.

### Confirmation
- **M1 validation:** D1 migration runs cleanly via `wrangler d1 migrations apply --local`. All CRUD operations work via Miniflare integration tests. `Intl.DateTimeFormat` timezone computation produces correct results in the Workers runtime.
- **M4 load test:** 100-user digest simulation completes within Cron Trigger time limits (after Queue fan-out).
- **Post-launch metric:** D1 query latency stays under 10ms P95 for all operations during dogfood phase.
