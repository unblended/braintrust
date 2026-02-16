---
name: compromise-log
description: Record compromise decisions as immutable, append-only artifacts during pipeline execution. Use when scope, quality bars, sequencing, or safeguards are deferred or altered from the baseline plan/spec.
---

# Compromise Log Skill

Use this skill whenever a compromise is accepted so the baseline plan remains immutable and the decision trail is never lost.

## When to use

Use this skill when any of the following happens:

- A reviewer warning or suggestion is accepted as "defer to later".
- A critic issue is partially addressed with a temporary workaround.
- A milestone ships with known gaps or reduced test depth.
- A security/reliability/cost guardrail is postponed.
- A human approves a scope cut that changes baseline expectations.

If there was no compromise in a step, do not use this skill.

## Core rules

1. **Never edit the baseline plan** (`plans/<slug>.md`) to record compromises.
2. **Create a new file per compromise event** (append-only audit trail).
3. **Use `new-doc`/`scripts/new_doc.sh`** to scaffold the file.
4. **Capture enough detail for future closure** (who, why, risk, and how to verify resolution).

## How to create a compromise log

1. Determine feature slug (`<slug>`) and step tag (`<step-tag>`).
   - Suggested step tag format: `step-<n>-<short-title>`
   - Examples: `step-3-spec-gaps`, `step-7-m1-review`, `step-6-m2-timeout-tradeoff`

2. Scaffold the document:

   ```bash
   ./scripts/new_doc.sh compromise "<slug>" "<step-tag>"
   ```

3. The file is created at:

   ```
   plans/compromises/<slug>/YYYYMMDD-<step-tag>.md
   ```

4. Fill all required sections from `docs/templates/compromise.md`.

## Required details before a step can close

Do not leave any of these blank:

- Pipeline step and milestone/task
- Decision statement and baseline expectation
- Why the compromise was accepted now
- Impact assessment (scope, AC/spec, security, reliability, cost, user impact)
- Risk level and guardrails in place now
- Follow-up owner, target milestone/step, and verification hook
- Amendment/supersession linkage
- Exit criteria and closure evidence target

## Supersession guidance

- If a new compromise replaces an older one, create a new compromise file and link both directions:
  - New file: `Supersedes prior compromise file(s)`
  - Old file reference can be recorded in release/retro artifacts (do not rewrite history if your workflow disallows edits)

## Recommended workflow in pipeline steps

1. Finish the step artifact + critique/review.
2. List accepted compromises.
3. Create one compromise file per accepted compromise via `new_doc.sh compromise`.
4. Present compromise file paths with the step output.
5. At milestone start, read open compromise files for that slug.

## Quality checks

- The compromise file exists under `plans/compromises/<slug>/`.
- `{{DATE}}`, `{{SLUG}}`, `{{TITLE}}`, and `{{EXTRA}}` tokens are replaced.
- The decision is specific enough that another engineer can resolve it later without oral context.
