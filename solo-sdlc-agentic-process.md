# Solo SDLC + Agentic AI Operating Process

THIS DOCUMENT IS FOR HUMANS NOT AGENTS/LLMs

This document defines the repeatable workflow for building and running solid apps/services as a single engineer using agentic AI. The core idea: **agents produce and verify artifacts**; **you approve decisions and merges**.

---

## Non-negotiable principles

1. **You are the bottleneck** — optimize for low decision load and fast feedback.
2. **Artifacts over chat** — decisions live in files, not in conversation history.
3. **Hard gates** — no step proceeds without objective checks.
4. **Small batches** — ship weekly (or faster). Avoid “big bang” rewrites.
5. **Observability-first** — if you can’t measure it, you can’t operate it alone.
6. **No agent merges to main** — agents propose; you approve.

---

## Agent roles

| Role | Agent file | Prompt file(s) | Responsibility |
|---|---|---|---|
| **Product Manager** | `product-manager.md` | `product_generate_opportunity-brief.md`, `product_generate_prd.md` | Drafts opportunity briefs + PRDs; tight non-goals |
| **System Architect** | `system-architect.md` | `architect_generate_spec-adrs.md` | Writes spec + ADRs + implementation plan; models data; failure modes |
| **Spec Executor** | `spec-executor.md` | `executor_generate-pr-ready-code.md` | Writes code in small PRs; follows repo standards |
| **Reviewer** | `reviewer.md` | `reviewer_generate_code-report.md` | Enforces conventions; catches footguns; "required changes only" |
| **QA** | `qa.md` | `qa_generate_test-plan.md` | Generates test plan; ensures test hooks; identifies regressions |
| **Security** | `security.md` | `security_generate_threat-model.md` | Validates authz boundaries; data handling; threat model |
| **Critic** | `critic.md` | `critic_generate_critique-report.md` | Stress-tests ideas, requirements, and plans before they become code |

All agent files live in `.opencode/agent/`. All prompt files live in `prompts/`.

**Lane discipline:** agents must not introduce scope or architecture changes outside PRD/ADR updates.

---

## Gates (objective checks)

### Document gates (human-checked)

- **Opportunity Brief**
  - measurable success metric exists
  - explicit non-goals exist
  - target user + top 3 jobs-to-be-done are clear

- **PRD**
  - critical path only
  - non-goals section is real (not empty)
  - rollout plan exists (flag/beta/pricing impact if relevant)

- **Spec/ADRs**
  - data invariants documented
  - failure modes listed (top 5)
  - authz boundaries explicitly stated

### Code gates (CI-enforced)

- formatting + lint
- typecheck
- unit tests
- integration/smoke tests (at least for the critical path)
- migration checks (apply on fresh DB; rollback if you support it)
- dependency/security scan (minimum baseline)

If a gate isn’t enforced, it’s not a gate.

---

## The feature pipeline (repeat every time)

**Rule:** each step reads prior artifacts and writes new artifacts/diffs.

### Step 1 — Opportunity Brief (you + Product + Critic)

**Output:** `docs/opportunity/<slug>.md`

- Problem statement (who/what/why now)
- Target user
- Success metric (measurable)
- Constraints (time/cost/legal/tech)
- Non-goals

**Gate:** if you can’t write a measurable success metric, stop.

### Step 2 — PRD (Product + Critic, you approve)

**Input:** opportunity brief  
**Output:** `docs/prd/<slug>.md`

- user stories (critical path only)
- non-goals (explicit)
- risks + mitigations
- analytics/events to measure
- rollout plan

**Your job:** cut scope until it fits 1–2 weeks.

### Step 3 — Spec + ADRs (Architect; Security/Perf review; you approve)

**Input:** PRD  
**Outputs:**

- `docs/spec/<slug>.md`
- `docs/adr/####-<decision>.md` (only real decisions)

Spec must include:

- data model + invariants
- API contracts (request/response)
- idempotency/retries/timeouts
- failure modes
- security boundaries (who can do what)

**Your job:** approve decisions; reject complexity you can’t operate.

### Step 4 — Plan (Tech-lead behavior; QA adds hooks; you approve)

**Input:** PRD + spec + ADRs  
**Output:** `plans/<slug>.md`

Plan must include:

- milestone sequence: DB → API → UI → tests → deploy → verify
- each task has definition of done + verification hook

**Your job:** ensure every task has a test or observable verification step.

### Step 5 — Build (Implementer; you merge)

**Input:** plan + repo standards  
**Output:** small PRs

Rules:

- 1 milestone per PR
- feature flag by default
- every PR updates tests/docs relevant to the change
- merge daily to avoid branch rot

**Your job:** keep PRs small and consistent; reject “drive-by refactors.”

### Step 6 — Review (Reviewer; you enforce)

**Input:** diffs  
**Output:** required changes list only:

- correctness
- consistency
- risk (security/perf/ops)

**Your job:** treat reviewer output as a gate, not advice.

### Step 7 — Test plan + automation (QA; you run final pass)

**Outputs:**

- `docs/test/<slug>-testplan.md`
- automated tests for the critical path

Test plan includes:

- happy path
- top 5 edge cases
- regression list
- basic load-ish check (even a small script)

**Your job:** run the plan end-to-end before release.

### Step 8 — Release + runbook + telemetry (agents assist; you own)

**Outputs:**

- `docs/runbook/<service>.md` updated
- dashboards/alerts exist (minimal is fine)
- release notes (PR description or `CHANGELOG.md`)

Minimum telemetry:

- request rate, errors, latency (RED)
- key business metric for the feature
- audit logs for sensitive actions

**Your job:** ensure you can answer in 60 seconds:

- Is it broken?
- Is it used?
- Is it costing money?

### Step 9 — Retro (you; agents can summarize)

**Output:** `docs/retro/<slug>.md`

- did the metric move?
- what broke/surprised you?
- what will you template/automate next?

**Your job:** update templates/gates based on pain. This is how the process compounds.

---

## Automation checklist (highest ROI)

Build these early:

1. **Feature pack generator**: creates skeleton files for a slug.
2. **CI gates**: lint/typecheck/tests/migrations/security scan.
3. **Artifact completeness check**: PR cannot merge unless PRD/spec/plan exist for the feature.
4. **Release checklist**: a single checklist you must tick before enabling the flag.

---

## Cadence (practical)

### Daily

- Merge at least one small PR
- Keep a short “Next 3” list (3 tasks max)

### Weekly

- Ship at least one user-visible improvement
- Write a 10-minute retro on what slowed you down
- Improve one automation/gate/template per week

---

## Common failure modes (avoid these)

- Letting agents expand scope mid-flight
- Skipping telemetry/runbooks and getting crushed by support
- Big branches that merge once a week (merge daily)
- “Architecture as procrastination” (ADRs should be short and rare)
- No distribution plan (product doesn’t matter without users)

---

## Definition of “done” for a feature

A feature is done only when:

- PRD success metric is measurable
- critical path is tested
- logs/metrics exist to observe it
- runbook is updated
- rollout/flag plan exists and has been executed
