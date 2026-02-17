
---
doc_type: compromise_log
date: 20260216
owner: you
status: open
slug: thought-capture
step_ref: step-3-v1-migration-rollback-drop-tables
---

# Compromise Log: thought-capture (step-3-v1-migration-rollback-drop-tables)

## Purpose
Capture a compromise decision as an immutable, append-only artifact without editing the baseline plan.

## Baseline References
- Immutable plan baseline: `plans/thought-capture.md`
- Related PRD: `docs/prd/thought-capture.md`
- Related spec: `docs/spec/thought-capture.md`
- Related ADRs: `docs/adr/0001-storage-engine.md`
- Related review/critique: Step 3 critic pass and approval notes

## Decision Context
- Pipeline step: Step 3 - Spec + ADRs + Plan
- Milestone/task: Migration/rollback strategy for V1 schema
- Trigger source (critic/reviewer/human/operational): architecture tradeoff accepted during design
- Date accepted: 2026-02-16
- Decision owner: feature owner

## Compromise Record
- Compromise ID (example: `CMP-20260216-01`): `CMP-20260216-09`
- Decision statement (what was accepted/deferred): Accept V1 rollback strategy of dropping tables (data-destructive) for early beta instead of full reversible migration workflow.
- Baseline expectation (what the original plan/spec expected): Safer rollback preserving production data and minimizing destructive operations.
- Reason for compromise now (constraint, risk, timeline, dependency): Greenfield beta with low criticality historical data; prioritized delivery speed and reduced operational complexity.
- Alternatives considered: Full shadow tables and migration reversal; backup/restore automation from day one; expand-contract with full rollback scripts.

## Impact Assessment
- Scope impact: Reduced initial migration complexity.
- Acceptance criteria impacted: None immediate for beta goals.
- Spec/ADR contracts impacted: Matches documented V1 rollback note in spec.
- Security/privacy impact: Low.
- Reliability/operability impact: Medium; rollback can cause full data loss if used.
- Cost/performance impact: Lower operational overhead in early phase.
- User impact: Potential loss of captured thought history during rollback incidents.

## Mitigation + Follow-up
- Risk level (`low` | `medium` | `high`): `medium`
- Guardrails in place now: Scope limited to dogfood/beta users; migration changes are forward-only by default.
- Follow-up action required: Introduce non-destructive rollback and backup guidance before wider rollout.
- Target milestone/step for resolution: M5 release hardening.
- Verification hook (test, query, alert, or runbook check): Runbook section with rollback preconditions and backup/restore validation drill.
- Owner for follow-up: feature owner

## Amendment / Supersession Trail
- Amends baseline plan section(s): Migration safety assumptions used from M1 through release.
- Supersedes prior compromise file(s): none
- Superseded by (future file, if applicable): TBD (when durable rollback strategy is implemented)

## Exit Criteria
- What must be true to close this compromise: Rollback process can recover from bad schema deploys without destructive table drops.
- Deadline or revisit trigger: Before opening beyond initial beta cohort.
- Closure evidence location: future supersession compromise file + runbook/ops test evidence.
