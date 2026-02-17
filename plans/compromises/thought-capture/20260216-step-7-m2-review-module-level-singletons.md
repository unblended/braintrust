
---
doc_type: compromise_log
date: 20260216
owner: you
status: open
slug: thought-capture
step_ref: step-7-m2-review-module-level-singletons
---

# Compromise Log: thought-capture (step-7-m2-review-module-level-singletons)

## Purpose
Capture a compromise decision as an immutable, append-only artifact without editing the baseline plan.

## Baseline References
- Immutable plan baseline: `plans/thought-capture.md`
- Related PRD: `docs/prd/thought-capture.md`
- Related spec: `docs/spec/thought-capture.md`
- Related ADRs: `docs/adr/0003-deployment-architecture.md`
- Related review/critique: Step 7 M2 reviewer report (MERGE WITH COMMENTS, W6, 2026-02-16)

## Decision Context
- Pipeline step: Step 7 - Review
- Milestone/task: M2 API layer review — W6
- Trigger source (critic/reviewer/human/operational): reviewer warning W6
- Date accepted: 2026-02-16
- Decision owner: feature owner

## Compromise Record
- Compromise ID (example: `CMP-20260216-01`): `CMP-20260216-13`
- Decision statement (what was accepted/deferred): Repository instances (`ThoughtRepository`, `UserPrefsRepository`, `AnalyticsRepository`) are created as module-level singletons initialized inside handler functions rather than using constructor-based dependency injection. This makes them harder to mock in isolation tests and couples handler modules to concrete repository implementations.
- Baseline expectation (what the original plan/spec expected): Clean dependency injection pattern where repositories are injected into handlers, enabling straightforward test doubles without module-level mocking.
- Reason for compromise now (constraint, risk, timeline, dependency): Cloudflare Workers D1 bindings are only available inside request handlers (from `env`), not at module initialization time. The current pattern of creating repositories inside handlers and passing them to service functions is functional and matches Workers idioms. A full DI refactor is a cross-cutting concern better addressed as a hardening task.
- Alternatives considered: (1) Factory function that accepts `env` and returns all repositories, (2) Lightweight DI container initialized per-request, (3) Pass `env.DB` directly into each function (no repository abstraction).

## Impact Assessment
- Scope impact: Defers DI refactor to M4.
- Acceptance criteria impacted: None.
- Spec/ADR contracts impacted: None — spec does not prescribe DI patterns.
- Security/privacy impact: None.
- Reliability/operability impact: Low. Current pattern works correctly; the concern is testability and maintainability.
- Cost/performance impact: None.
- User impact: None.

## Mitigation + Follow-up
- Risk level (`low` | `medium` | `high`): `low`
- Guardrails in place now: Tests use `@cloudflare/vitest-pool-workers` which provides real D1 bindings, sidestepping the mocking concern. Integration-style tests validate actual behavior.
- Follow-up action required: Refactor to a per-request factory or lightweight DI pattern in M4.
- Target milestone/step for resolution: M4 (Tests + hardening)
- Verification hook (test, query, alert, or runbook check): After refactor, verify all existing tests still pass and new unit tests can mock repositories without module-level hacks.
- Owner for follow-up: feature owner

## Amendment / Supersession Trail
- Amends baseline plan section(s): M4 hardening / code quality tasks.
- Supersedes prior compromise file(s): none
- Superseded by (future file, if applicable): TBD (after M4 refactor)

## Exit Criteria
- What must be true to close this compromise: Repository creation uses a DI-friendly pattern (factory or container) and handler tests can inject test doubles cleanly.
- Deadline or revisit trigger: Before completing M4 review gate.
- Closure evidence location: M4 code refactor + test evidence.
