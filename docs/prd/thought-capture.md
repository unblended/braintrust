
---
doc_type: prd
date: 20260215
owner: you
status: draft
slug: thought-capture
---

# PRD: thought-capture

## Summary

A Slack bot that lets staff engineers capture fleeting thoughts via DM, automatically classifies each thought using an LLM (Action Required / Reference / Noise), and delivers a weekly interactive digest of actionable items via Slack Block Kit. No app, no dashboard, no tagging — just message-in, digest-out. This matters because high-signal ideas from senior ICs decay within days when scattered across ad-hoc capture tools, and manual triage doesn't scale past ~2 weeks.

## Problem statement

- **Who:** Staff-and-above engineers (IC5/IC6) at technology companies with 50–500 engineers. They have 5–15 years of experience, manage no direct reports, but influence architecture and technical direction across multiple teams. They generate 10–30 actionable-or-maybe-actionable thoughts per week.
- **Pain:** Fleeting technical insights — "we should deprecate X," "follow up with Z about that perf cliff," "write a design doc for Y" — are captured across 3+ disconnected tools (Slack DMs-to-self, Apple Notes, scratch files, browser tabs). There is no single low-friction intake, and critically, no automatic triage. High-signal ideas rot next to grocery lists. Most engineers abandon manual review within ~2 weeks.
- **How they solve it today:** DM-to-self in Slack, Apple Notes, draft emails, scratch files. All require context-switching to capture, manual review to triage, and produce no signal about what actually warrants action. Net result: ideas are captured but never resurfaced.
- **Why now:** (1) GPT-4-class LLMs can classify short, partially-formed thoughts into coarse action categories with >85% accuracy — previously impractical. (2) Slack's Bot/Events API is mature and ubiquitous in the target demographic. (3) Staff-engineer productivity tooling is a growing investment area; reclaiming 30 min/week of "rediscovering what I was thinking" time has outsized ROI at senior IC comp levels.
- **Impact:** If 100 beta users each recover 30 min/week of rediscovery time, that is ~50 hours/week of senior IC capacity unlocked — equivalent to >1 FTE of staff-engineer time.

## Goals

- **G1: Near-zero-friction capture.** A staff engineer can capture a thought by sending a Slack DM to the bot in <10 seconds, with no context switch, no app launch, no metadata entry.
- **G2: Automated triage.** Every captured thought is LLM-classified into one of three bins (Action Required, Reference/Save, Noise/Ephemeral) without any user input.
- **G3: Timely resurfacing.** All "Action Required" items are surfaced in a weekly Slack digest with interactive Block Kit buttons so the user can mark items as "acted on," "snooze," or "dismiss."
- **Primary success metric:** Within 8 weeks of beta launch (Weeks 5–12), ≥60% of active users mark at least 1 resurfaced "Action Required" item as "acted on" per digest week. **Active user definition:** a user who has sent ≥5 thoughts to the bot within the trailing 14-day window relative to digest send date. Measurement begins after a user has received at least 2 weekly digests.
- **Secondary success metric:** ≥80% of surveyed beta users report that capturing a thought takes <15 seconds, measured via structured survey at week 4 and week 8 of beta. (Note: this is a qualitative self-report, not an instrumented latency measurement.)

## Non-goals

- **NG1: No mobile app or web dashboard.** V1 is Slack-only. No native app, no web UI, no standalone frontend.
- **NG2: No rich media capture.** Text only. No images, voice memos, screenshots, or file attachments.
- **NG3: No search or browse interface.** Users cannot search, filter, or browse past thoughts in V1. The digest is the only resurfacing mechanism.
- **NG4: No task management integrations.** No syncing to Jira, Linear, Asana, GitHub Issues, or any external task tracker.
- **NG5: No multi-channel ingest.** V1 supports Slack DM only. No email, iMessage, Telegram, or SMS intake. Slack was chosen because: (1) it is already open during work hours for the target persona, requiring no app install or context switch; (2) its Bot/Events API and Block Kit provide mature interactive messaging primitives; (3) single-channel simplifies the build for a solo operator within the 4-week timebox.
- **NG6: No manager or non-engineering personas.** V1 targets staff-and-above ICs only. Product managers, engineering managers, and other roles are out of scope.
- **NG7: No custom classification taxonomies.** Users cannot create custom bins or modify the three-bin classification scheme.

## User stories (critical path only)

1. **As a** staff engineer, **I want to** send a quick DM to the Thought Capture bot with a partially-formed idea, **so that** I can capture it in <10 seconds without leaving my current context.
   - **AC:** Bot acknowledges receipt within 2 seconds with a ✅ reaction or short confirmation message. The thought is persisted.

2. **As a** staff engineer, **I want** every thought I send to be automatically classified as "Action Required," "Reference," or "Noise," **so that** I don't have to manually triage my own ideas.
   - **AC:** Classification happens asynchronously within 30 seconds of receipt. Classification label is stored with the thought record. No user input is required.

3. **As a** staff engineer, **I want to** receive a weekly Slack digest listing all my "Action Required" thoughts from the past week, **so that** I can review and act on the ones that still matter.
   - **AC:** Digest is delivered as a Slack Block Kit message at a configurable day/time (default: Monday 9:00 AM user-local-time). Each item includes the original thought text, capture timestamp, and three interactive buttons: "Acted on," "Snooze 1 week," "Dismiss."

4. **As a** staff engineer, **I want to** tap "Acted on," "Snooze," or "Dismiss" on each digest item, **so that** I can close the loop without leaving Slack.
   - **AC:** Button tap updates the item's status immediately. "Acted on" removes it from future digests. "Snooze" re-surfaces it in the next week's digest. "Dismiss" removes it from future digests and marks it as dismissed. The button interaction is acknowledged visually (button text updates or item grays out).

5. **As a** staff engineer, **I want to** override the bot's classification if it got it wrong, **so that** important items aren't missed and noise doesn't clutter my digest.
   - **AC:** The bot's acknowledgment message includes a brief label ("📌 Action" / "📁 Reference" / "🗑 Noise"). User can react with a designated emoji or reply "reclassify as action" to override. Override is reflected in the next digest.

## UX / flows (rough)

- **Entry points:**
  - User opens a DM conversation with the Thought Capture Slack bot.
  - User types a thought and hits Enter. That's it.

- **Happy path:**
  1. User sends DM → Bot reacts with ✅ within 2s.
  2. Bot classifies thought asynchronously (<30s) and posts a short reply: "Got it — classified as 📌 Action Required."
  3. On Monday at 9 AM local time, user receives a Block Kit digest message in the bot DM:
     - Header: "Your Action Items This Week (5 items)"
     - Each item: original text, timestamp, three buttons [Acted on] [Snooze] [Dismiss].
  4. User taps buttons to disposition items.

- **Empty states:**
  - If no "Action Required" items exist for a given week, send a short message: "No action items this week. You captured N thoughts — all classified as Reference or Noise."
  - If user has never sent a thought: no digest is sent. Bot welcome message on first DM explains usage.

- **Error states:**
  - LLM API timeout/failure: Persist the thought with classification = "Unclassified." Include unclassified items in the next digest under a separate "Needs Review" section.
  - Slack API failure on digest delivery: Retry with exponential backoff (3 attempts over 1 hour). If all retries fail, log alert and attempt delivery on next scheduled day.
  - User sends non-text content (image, file): Reply with "I can only capture text thoughts right now. Try typing it out!"

## Requirements

### Functional

- **R1: Slack bot DM ingest.** The system must accept plain-text DMs sent to the bot and persist each message as a "thought" record with: user ID, message text, timestamp, and classification status.
- **R2: LLM classification.** Each thought must be classified into exactly one of three categories: `action_required`, `reference`, `noise`. Classification must complete within 30 seconds of message receipt.
- **R3: Classification override.** Users must be able to override the bot's classification via emoji reaction or text reply. Override must take effect before the next digest.
- **R4: Weekly digest — Block Kit interactive message.** The system must send a weekly Slack message using Block Kit containing all `action_required` items from the trailing 7 days (plus any snoozed items from prior weeks). Each item must include three interactive buttons: "Acted on," "Snooze 1 week," "Dismiss."
- **R5: Button interaction handling.** The system must handle Block Kit button interactions and update item status in real-time. Status changes: `acted_on`, `snoozed`, `dismissed`. Snoozed items re-enter the next digest.
- **R6: Digest scheduling.** Default digest day/time is Monday 9:00 AM in the user's Slack-configured timezone. Users can change this via a `/thoughtcapture schedule` slash command (day-of-week + time).
- **R7: Welcome message.** On first DM, the bot sends a one-time welcome message explaining: what it does, how to capture a thought, when digests arrive, and how to override classification.
- **R8: Empty-week digest.** If no action-required items exist for a digest period, send a brief summary message (thought count + classification breakdown) instead of an empty digest.

### Non-functional

- **Performance:**
  - Bot acknowledgment (✅ reaction) within 2 seconds of message receipt (P95).
  - LLM classification completes within 30 seconds of message receipt (P95).
  - Digest generation and delivery completes within 60 seconds per user (P95).

- **Reliability:**
  - Thought persistence must succeed even if LLM classification fails (decouple intake from classification).
  - Digest delivery: retry with exponential backoff, 3 attempts over 1 hour.
  - System availability target: 99.5% uptime (measured monthly), excluding scheduled maintenance.

- **Security/privacy:**
  - Thoughts are stored per-user and never shared across users.
  - Thought text is sent to a DPA-capable LLM provider (or self-hosted model) for classification. For beta: users accept standard API ToS. Enterprise readiness (self-hosted/DPA model) is a post-V1 concern.
  - Data retention: thoughts are retained for 90 days after creation, then auto-deleted. Acted-on/dismissed items retain metadata (status, timestamp) but text is purged.
  - No PII extraction or storage beyond Slack user ID.

- **Accessibility:**
  - All interactions occur via standard Slack UI (DM, Block Kit buttons, emoji reactions). No custom UI that requires separate accessibility testing.
  - Digest messages must be readable by screen readers (use Block Kit `text` blocks, not image-based layouts).

- **Observability:**
  - Structured logging for: thought ingested, classification result, classification latency, digest sent, button interaction received.
  - Alerting on: LLM API error rate >5% over 5-minute window, digest delivery failure, classification queue depth >100.

## Analytics / instrumentation

- **Events (track each with timestamp + user_id):**
  - `thought.captured` — user sends a DM to the bot.
  - `thought.classified` — LLM returns classification. Properties: `category`, `latency_ms`, `model_version`.
  - `thought.override` — user overrides classification. Properties: `from_category`, `to_category`.
  - `digest.sent` — weekly digest delivered. Properties: `item_count`, `snoozed_item_count`.
  - `digest.item.acted_on` — user taps "Acted on."
  - `digest.item.snoozed` — user taps "Snooze."
  - `digest.item.dismissed` — user taps "Dismiss."
  - `digest.engagement` — at least 1 button interaction received on a digest message. Properties: `time_to_first_interaction_ms`.

- **Funnels:**
  - **Capture → Classification → Digest → Action funnel:** What % of captured thoughts classified as `action_required` are ultimately marked `acted_on`?
  - **Weekly engagement funnel:** Of users who receive a digest, what % interact with ≥1 button within 48 hours?

- **Guardrail metrics:**
  - Classification accuracy: ≥85% agreement with user overrides (i.e., override rate <15%). If override rate is 15–20%, flag for prompt tuning. If >20%, pause rollout and investigate.
  - LLM cost per user per month: must stay <$0.50/user/month (see cost estimate in Risks).
  - Digest engagement rate: ≥70% of digests receive at least 1 button interaction within 48 hours.

## Rollout plan

- **Feature flag:** `thought_capture_v1`. Controls: bot activation, digest delivery, and LLM classification. Can be toggled per Slack workspace or per user ID.
- **Beta cohort:** 20–30 staff engineers across 2–3 Slack workspaces. Recruited via internal opt-in. Run for 8 weeks.
- **Timeline (total: ~13 weeks from kickoff to metric evaluation):**

  | Phase | Calendar Weeks | Activity |
  |-------|---------------|----------|
  | **Validation** | Week 0 | Pre-build classification experiment: 200 thoughts, 5 engineers. Gate: ≥85% accuracy to proceed, 80–85% proceed with prompt tuning plan, <80% stop. |
  | **Build** | Week 1–4 | Implement Slack bot, LLM classification, digest delivery, Block Kit interactions. |
  | **Dogfood** | Week 5 | Internal only (5 users). Validate intake, classification, and digest end-to-end. |
  | **Beta ramp** | Week 6–7 | Expand to 20–30 beta users. Monitor classification accuracy and override rates. If accuracy <85%, tune prompts before expanding. |
  | **Beta hold** | Week 8–12 | Full beta cohort. Measure primary success metric over 8 digest weeks. Collect qualitative feedback. |
  | **Evaluate** | Week 13 | Evaluate primary metric. Decision: expand, iterate, or kill. |
- **Migration considerations:** None. Greenfield product — no existing data or workflows to migrate.
- **Rollback plan:** Disable feature flag. Bot stops responding to new DMs (sends "Thought Capture is temporarily unavailable" message). Existing thought data is retained. Digests stop sending.

## Dependencies

- **External:**
  - **Slack API:** Bot Users, Events API (for DM receipt), Block Kit (for interactive digests), Web API (for message posting and reactions). Requires a Slack app with appropriate OAuth scopes (`im:history`, `im:write`, `reactions:write`, `chat:write`, `users:read`).
  - **LLM API:** GPT-4-class model via OpenAI API (or equivalent DPA-capable provider). Required for thought classification.

- **Internal:**
  - Persistent data store for thought records (user_id, text, timestamp, classification, status).
  - Scheduled job runner for weekly digest generation and delivery.
  - No dependencies on existing internal products or services (greenfield).

## Risks & mitigations

- **Risk 1: LLM classification accuracy below threshold.**
  - The opportunity brief claims >85% accuracy, but this is based on general LLM capability, not validated on this specific task with staff-engineer thought patterns.
  - **Mitigation:** Run a pre-build validation in **Week 0** (before any code is written): take 200 sample thoughts (sourced from 5 volunteer staff engineers' Slack DMs-to-self and Apple Notes), classify with the target model, have the thought authors label ground truth. If accuracy is <80%, do not proceed to build. If 80–85%, proceed with caution and plan for prompt iteration. If ≥85%, green-light.
  - **De-risk gate (Week 0): ≥85% accuracy on the 200-thought validation set is the go/no-go threshold. 80–85% is "proceed with caution" — requires prompt tuning plan before build. <80% is a hard blocker — do not start Week 1.**

- **Risk 2: LLM API cost exceeds budget.**
  - **Back-of-envelope cost estimate:** 100 users × 20 thoughts/week × 4 weeks = 8,000 classifications/month. Each classification prompt ≈ 300 tokens input + 50 tokens output = 350 tokens. At GPT-4o pricing (~$2.50/1M input, $10/1M output): input cost = 8,000 × 300 × $2.50/1M = $6.00; output cost = 8,000 × 50 × $10/1M = $4.00. **Total ≈ $10/month for 100 users ($0.10/user/month).** Well within the $50/month budget. Even with 3x buffer for retries/prompt iteration: ~$30/month.
  - **Mitigation:** Use GPT-4o-mini or equivalent cheaper model if accuracy holds. Monitor cost weekly via API dashboard. Set hard spending cap at $50/month.

- **Risk 3: Low adoption — users don't form the capture habit.**
  - **Mitigation:** Onboarding welcome message. Weekly digest itself serves as a re-engagement prompt. Track `thought.captured` events per user per week. If median drops below 3/week after week 2, investigate via qualitative interviews.

- **Risk 4: Slack rate limits or API changes.**
  - **Mitigation:** Implement rate-limit-aware retry logic. Digest delivery is staggered across the delivery window (not all users at 9:00 AM sharp). Monitor Slack API changelog.

- **Risk 5: Privacy concern — users uncomfortable sending sensitive technical thoughts to an LLM API.**
  - **Mitigation:** Transparent onboarding: explain what data is sent, to whom, and retention policy. Beta users explicitly opt in with acknowledgment of LLM API ToS. Post-V1: evaluate self-hosted model option.

## Open questions (keep short; should go to 0 before build)

1. **Digest timing preference:** Is Monday 9 AM the right default, or do staff engineers prefer Friday afternoon (for weekly planning) or Sunday evening (for week-ahead prep)? **Resolution plan:** Survey beta cohort before launch; make configurable regardless.
2. **Snooze duration:** Is 1-week snooze the right interval, or should we offer 1-day and 1-month options? **Resolution plan:** Ship with 1-week only; add options based on feedback.
3. **Classification prompt design:** What system prompt and few-shot examples produce ≥85% accuracy on staff-engineer thoughts? **Resolution plan:** Resolve during Week 0 validation experiment. Must be complete before build starts.
4. **Storage engine selection:** SQLite, Postgres, or managed DB? Must support: timezone-aware scheduled queries, TTL-based deletion (90-day retention), and per-user data isolation. **Resolution plan:** Decide in engineering spec. Total infrastructure cost (compute + storage + monitoring) must stay under a defined budget — specify in spec alongside LLM cost estimate.

## Acceptance criteria

- **AC1:** A user can send a plain-text DM to the Thought Capture Slack bot and receive a ✅ reaction acknowledgment within 2 seconds (P95).
- **AC2:** Each captured thought is classified by the LLM into exactly one of `action_required`, `reference`, or `noise` within 30 seconds of receipt (P95). The classification label is visible to the user in the bot's reply.
- **AC3:** A user can override the bot's classification by replying with "reclassify as [action/reference/noise]" or reacting with a designated emoji. The override is stored and reflected in the next digest.
- **AC4:** Every Monday at 9:00 AM user-local-time (or user-configured day/time), the bot sends a Slack Block Kit message listing all `action_required` and `snoozed` items. Each item displays: original thought text, capture date, and three interactive buttons — "Acted on," "Snooze 1 week," "Dismiss."
- **AC5:** Tapping "Acted on" marks the item as `acted_on` and removes it from future digests. Tapping "Snooze" marks it as `snoozed` and includes it in the next digest. Tapping "Dismiss" marks it as `dismissed` and removes it from future digests. Each button interaction produces an immediate visual update in the Slack message.
- **AC6:** If the LLM API is unavailable, the thought is still persisted with classification = `unclassified` and included in the next digest under a "Needs Review" section.
- **AC7:** If no `action_required` items exist for a digest period, the bot sends a summary message ("No action items this week. You captured N thoughts.") instead of an empty digest.
- **AC8:** LLM classification accuracy is ≥85% as measured by override rate over the 8-week beta (i.e., user overrides <15% of classifications).
- **AC9:** Within the 8-week beta period (Weeks 5–12), ≥60% of active users (defined as users who sent ≥5 thoughts in the trailing 14-day window) mark at least 1 "Action Required" item as "acted on" per digest week.
- **AC10:** Monthly LLM API cost for up to 100 beta users does not exceed $50.
