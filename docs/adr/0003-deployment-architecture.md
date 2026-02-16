
---
doc_type: adr
date: 20260216
owner: you
status: proposed  # proposed | accepted | deprecated | superseded
slug: deployment-architecture
---

# ADR: Deployment Architecture — Cloudflare Workers

_Supersedes previous proposal: Single Long-Running Process on Railway_

## Context and Problem Statement
The system must: (1) receive Slack webhook events in real-time (DMs, button interactions, slash commands), (2) run scheduled jobs (weekly digest delivery, daily TTL cleanup), (3) process async work (LLM classification), and (4) make outbound API calls (OpenAI, Slack). It must achieve 99.5% uptime monthly. A solo operator must be able to deploy, monitor, and debug it at 3 AM. The 4-week build timebox demands minimal infrastructure complexity.

**New constraint:** The deployment platform is Cloudflare. All infrastructure must use Cloudflare services.

## Decision Drivers
- Must meet Slack's 3-second webhook acknowledgment requirement (no cold start penalty)
- Single-platform architecture preferred to minimize operational complexity for a solo operator
- Durable async processing for LLM classification (no data loss on process restart)
- Platform-native scheduled job support (no in-process cron)
- Cost-effective at 100-user beta scale ($0-10/month target)
- Simple deployment and rollback (single command)

## Considered Options
- **Option A: Cloudflare Workers (HTTP handler + Queues + Cron Triggers)**
  - Pros: Near-zero cold starts (~0ms) — trivially meets Slack's 3-second ack requirement. Workers handle HTTP webhooks natively. Cloudflare Queues provide durable async processing with built-in retry and dead-letter queue semantics. Cron Triggers handle scheduled jobs (digest delivery every 15 min, TTL cleanup daily) as first-class primitives. D1 (SQLite) for storage is accessed via bindings — no network hop. Single deployment artifact via `wrangler deploy`. `wrangler dev --local` for local development with no external dependencies. Cost: $0/month on free tier (100K requests/day, 10ms CPU/invocation) at beta scale; $5/month Workers Paid plan for production use. Global edge deployment by default. Built-in structured logging via Workers Logs / Logpush.
  - Cons: 30-second CPU time limit per request — but classification is offloaded to Queues, so this is not a constraint in practice. Workers runtime is not full Node.js — some npm packages may need polyfills or alternatives (e.g., no `node:fs`, no `node:net`). `@slack/bolt` SDK assumes a long-running Node.js server and isn't directly compatible — must handle Slack webhooks manually with `@slack/web-api` for outbound calls and manual HMAC verification for inbound events. Debugging distributed invocations (webhook handler + queue consumer + cron) is slightly more complex than a single process log stream — mitigated by correlation IDs and Workers Trace Events.

- **Option B: Single long-running process (Node.js/TypeScript on Railway or Render)**
  - Pros: One process handles everything — simple mental model. Single log stream. `@slack/bolt` works out of the box. No cold starts.
  - Cons: Not on Cloudflare platform — adds a separate vendor for compute. Network hop to D1 is not possible (D1 is only accessible via Workers bindings). Would require a different database (Neon Postgres), adding another external dependency. `node-cron` for scheduling is less reliable than platform-native cron triggers (process restart loses cron state). Single point of failure. More expensive ($5-7/month for always-on process).

- **Option C: Cloudflare Pages Functions**
  - Pros: Git-push deployment. Similar to Workers under the hood.
  - Cons: Designed for full-stack web apps, not API-only bots. Less control over routing. Cron Triggers and Queues integration is less mature via Pages. Adds unnecessary abstraction.

## Decision Outcome
Chosen option: **Option A — Cloudflare Workers**, because:

1. **Near-zero cold starts (~0ms).** Slack's Events API requires a 3-second acknowledgment. Workers start in under 1ms — the original concern about serverless cold starts (ADR-0003 v1) does not apply to Cloudflare Workers. The 2-second P95 ack target is trivially met.
2. **Single-platform architecture.** Workers (compute) + D1 (storage) + Queues (async processing) + Cron Triggers (scheduling) are all Cloudflare-native. One vendor, one CLI (`wrangler`), one deployment pipeline, one billing dashboard.
3. **Cloudflare Queues replace the in-memory classification queue.** The original design used an in-memory queue that would lose items on process restart. Queues are durable, support automatic retries with configurable backoff, and provide dead-letter queue semantics. This is strictly better than in-memory.
4. **Cron Triggers replace `node-cron`.** Platform-native cron is more reliable than in-process scheduling — it runs regardless of Worker state, has no drift, and is monitored by Cloudflare. The digest scheduler (every 15 min) and TTL cleanup (daily at 03:00 UTC) are defined declaratively in `wrangler.toml`.
5. **Cost is lowest.** Free tier covers beta (100K requests/day, 10ms CPU). Paid plan is $5/month. D1 adds $0-5/month. Total: $0-10/month — cheaper than Railway + Neon.
6. **Deployment is simple.** `wrangler deploy` from CI or command line. `wrangler rollback` for instant rollback to previous version. No Docker, no Dockerfile, no container registry.
7. **`@slack/bolt` incompatibility is manageable.** Handling Slack events manually (HMAC verification + JSON parsing + `@slack/web-api` for outbound) is ~100 lines of straightforward code. This is simpler than it sounds — Bolt is largely a convenience wrapper around these primitives.

### Consequences
- Good, because near-zero cold starts eliminate Slack ack latency concerns.
- Good, because durable Queues replace fragile in-memory queue — no data loss on restart.
- Good, because platform-native Cron Triggers are more reliable than in-process scheduling.
- Good, because single-platform architecture minimizes operational complexity.
- Good, because deployment is a single command (`wrangler deploy`) with instant rollback.
- Good, because cost is $0-10/month — lowest of all options considered.
- Bad, because `@slack/bolt` cannot be used directly — must handle Slack webhooks manually (~100 lines of code). Mitigated: the manual approach is well-documented and gives us more control over the request lifecycle.
- Bad, because 30-second CPU time limit per request. Mitigated: classification (the only CPU-intensive work) runs in a Queue consumer, not inline. Webhook handlers and cron jobs are well within limits.
- Bad, because Workers runtime is not full Node.js — some npm packages may not work. Mitigated: we depend on `openai` SDK (Workers-compatible), `@slack/web-api` (Workers-compatible via fetch — **must be validated in M1 Day 1; fallback: raw `fetch` wrappers for 5 Slack API methods**), and standard Web APIs. No problematic dependencies.
- Bad, because debugging spans three execution contexts (HTTP handler, Queue consumer, Cron Trigger) instead of one process. Mitigated: correlation IDs (`thought_id`, `user_id`) in structured logs tie events together. Workers Trace Events provide request-level observability.

### Confirmation
- **M1 Day 1 validation:** `wrangler dev --local` starts the Worker, D1 binding is accessible, Queue binding is accessible, and `@slack/web-api` `WebClient` (or fallback `SlackClient`) can make a `chat.postMessage` call.
- **M2 integration test:** Full Slack webhook -> D1 -> Queue -> OpenAI -> Slack reply flow completes end-to-end via `wrangler dev --local`.
- **M4 performance test:** 100-user digest simulation completes within Queue consumer time limits. Cron Trigger (lightweight enqueue-only) stays well under 30-second CPU limit.
