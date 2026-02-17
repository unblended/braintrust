
---
doc_type: opportunity
date: 20260215
owner: you
status: draft
slug: thought-capture
---

# Opportunity Brief: LLM-Powered Thought Capture & Resurfacing for Staff Engineers

## Problem
- **Who is experiencing the pain?** Staff-and-above engineers who generate a high volume of ideas, observations, and partially-formed technical insights throughout their workday — during code reviews, architecture discussions, 1:1s, incident response, and deep work sessions.
- **What are they trying to do?** Capture fleeting thoughts with near-zero friction and later resurface the ones that warrant action (e.g., "write a design doc for X," "propose we deprecate Y," "follow up with Z about that performance cliff").
- **What is breaking or missing today?** Thoughts are scattered across Slack DMs-to-self, Apple Notes, drafts folders, scratch files, and browser tabs. There is no single low-friction intake point, and — critically — no automatic triage. The result: high-signal ideas rot alongside grocery lists, and actionable insights are lost within days. Manual review of a growing pile is unsustainable; most engineers stop reviewing after ~2 weeks.

## Why now
- **LLM classification capability:** Foundation models (GPT-4-class and above) can now reliably classify a short, partially-formed thought into coarse action categories (e.g., "action required," "reference/save," "discard") with acceptable accuracy (>85%) — a task that was impractical with keyword/rule-based approaches.
- **Ubiquitous messaging APIs:** Slack, iMessage, Telegram, and email all have mature inbound APIs or integrations, making "send a message to capture a thought" trivially implementable.
- **Staff-engineer productivity is a growing investment area:** Engineering orgs are increasingly focused on staff+ leverage. Tools that reclaim even 30 minutes/week of "re-discovering what I was thinking" time have outsized ROI at senior IC comp levels.

## Target user
- **Primary persona:** Staff Engineer (IC5/IC6 equivalent) at a technology company with 50-500 engineers. 5-15 years of experience. Manages no direct reports but influences architecture, process, and technical direction across multiple teams. Generates 10-30 "I should do something about this" thoughts per week. Currently uses 3+ different apps to jot things down. **Assumption:** This persona values speed of capture over organizational structure.
- **Context of use:** On-the-go capture during or immediately after meetings, code review, incident response, or hallway conversations. Resurfacing happens during weekly planning, 1:1 prep, or dedicated "think time" blocks. Devices: laptop (primary), phone (secondary for capture).

## Jobs-to-be-done (top 3)
1. **Capture a thought in <10 seconds** without switching context or choosing a destination — so that the idea is preserved before it decays.
2. **Automatically classify thoughts into actionable vs. reference vs. noise** — so that I don't have to manually triage a growing inbox of my own notes.
3. **Surface the "action required" thoughts at the right moment** (e.g., during weekly planning or before a relevant meeting) — so that high-signal ideas convert into real outcomes instead of being forgotten.

## Current alternatives
- **How do they solve it today?**
  - Slack DM to self / "saved messages"
  - Apple Notes / Google Keep / Notion personal workspace
  - Draft emails to self
  - Physical notebook + occasional photo
  - TODO comments in code
- **What do they hate about those options?**
  - **Fragmentation:** Thoughts live in 3-5 places; no unified view.
  - **No triage:** Everything has equal weight. Reviewing a flat list of 200 notes is demoralizing and ineffective.
  - **No resurfacing:** Notes apps are write-only in practice. Without active pull, captured thoughts are never revisited.
  - **Context switching cost:** Opening a dedicated app to capture a thought breaks flow; many thoughts are simply lost because the friction is too high.

## Proposed wedge
- **The smallest version that creates real value:** A single inbound channel (e.g., a dedicated Slack bot DM, SMS number, or email address) where the user sends raw, unstructured thoughts as text. An LLM classifies each thought into one of 3 bins: **Action Required**, **Reference/Save**, **Noise/Ephemeral**. A weekly digest (email or Slack message) surfaces all "Action Required" items from the past 7 days, ordered by recency. That's it — no app, no dashboard, no tagging UI, no integrations beyond input + output channels. **Assumption:** The 3-bin classification is coarse enough for LLMs to handle with >85% accuracy on real user input, and granular enough to deliver value.

## Success metric (must be measurable)
- **Primary:** Within 8 weeks of launch, 60% of active users (defined as users who sent at least 5 thoughts in the past 2 weeks) mark at least 1 resurfaced "Action Required" item as "acted on" per week — measured via a single-tap confirmation in the weekly digest.
- **Secondary:** Average capture-to-send latency < 15 seconds (measured from first character typed to message sent), indicating the capture friction is genuinely low.

## Constraints
- **Timebox:** 4-week build for V1 (wedge scope only).
- **Budget:** Bootstrapped / side-project scale. LLM API costs must stay under $50/month for up to 100 beta users.
- **Tech constraints:** Must work with at least one existing messaging platform (Slack, email, or SMS) — no custom mobile app in V1. **Assumption:** Users will tolerate a messaging-based UX without a dedicated app.
- **Legal/compliance constraints:** Thoughts may contain proprietary/confidential company information. LLM provider must support data processing agreements (DPA) or the classification model must be self-hosted. This is a hard constraint for enterprise adoption. **Assumption:** Beta users (founder + friends) will accept a hosted LLM with standard API ToS for initial validation.

## Risks & unknowns
- **Biggest uncertainty:** Will the 3-bin LLM classification be accurate enough on real, messy, context-poor input to be trusted? If users have to manually re-triage more than ~20% of items, the value proposition collapses — it becomes just another inbox.
- **How you'll de-risk it:**
  1. **Experiment (Week 1):** Collect 100 real thoughts from 3-5 staff engineers (including the founder). Run them through an LLM classifier. Measure agreement rate between LLM classification and the author's own retrospective classification. Gate: >80% agreement to proceed.
  2. **Prototype (Week 2-3):** Deploy the Slack bot + weekly digest to 5 users. Measure capture frequency and digest engagement qualitatively.
  3. **Interview (Week 4):** Structured interviews with beta users. Key question: "Did you act on something this week that you would have otherwise forgotten?"
- **Additional risk:** The "weekly digest" cadence may be wrong. Some action items are time-sensitive and a weekly batch may be too slow. **Mitigation:** Track how many "Action Required" items become stale before the digest arrives; if >30%, explore real-time nudges in a future iteration.

## Not doing (explicit)
- **Not building a mobile app or web dashboard in V1.** The wedge is messaging-in, digest-out. No UI beyond what Slack/email already provides.
- **Not supporting rich media capture** (images, voice memos, screenshots) in V1. Text only.
- **Not building a search/browse interface** for past thoughts. V1 is push-only (digest). Pull-based retrieval is a future iteration.
- **Not integrating with task management tools** (Jira, Linear, Asana) in V1. The "action" happens outside the system; we only surface the prompt.
- **Not targeting managers or non-engineering roles.** The classification model and resurfacing cadence are designed for staff-engineer workflows specifically.

## Next step
- [x] Write PRD
