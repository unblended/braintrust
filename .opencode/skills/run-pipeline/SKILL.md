---
name: run-pipeline
description: Run the solo SDLC feature pipeline. Use when asked to start a feature, run the pipeline, or execute a specific pipeline step (opportunity, prd, spec, plan, build, review, test, security, release, retro).
---

# Feature Pipeline

Run the solo SDLC pipeline for a feature. Each step reads prior artifacts, produces new artifacts, and must pass gate checks before proceeding.

**Core rule**: Agents produce artifacts; the human approves decisions and merges. Never skip a gate.

## Immutable Plan Rule + Compromise Logs

- Treat `plans/<slug>.md` as immutable once approved.
- If a step accepts any compromise (deferment, scope cut, reduced quality bar, temporary workaround), create a new compromise file instead of editing the baseline plan.
- Use `new-doc` type `compromise`:

  ```bash
  ./scripts/new_doc.sh compromise "<slug>" "step-<n>-<short-title>"
  ```

- Output path: `plans/compromises/<slug>/YYYYMMDD-<step-tag>.md`
- Recommended skill: `compromise-log` (captures required details and audit trail quality checks).
- Step closure gate: either (a) compromise file(s) created and shared, or (b) explicit statement: "No compromises accepted in this step." 

## Pipeline Steps

### Step 1 — Opportunity Brief

|            |                                                                                |
| ---------- | ------------------------------------------------------------------------------ |
| **Agent**  | product-manager                                                                |
| **Prompt** | `prompts/product_generate_opportunity-brief.md`                                |
| **Input**  | Raw idea from user                                                             |
| **Output** | `docs/opportunity/YYYYMMDD-<slug>.md`                                          |
| **Gate**   | Measurable success metric exists; target user is specific; at least 1 non-goal |

**How to run:**

1. Ask the user for the idea/problem if not already provided.
2. Determine the slug from the idea.
3. Use `new-doc` skill: `./scripts/new_doc.sh opportunity "<slug>"`
4. Invoke the **product-manager** agent with the prompt content from `prompts/product_generate_opportunity-brief.md` and the raw idea as context.
5. After the agent fills the brief, invoke the **critic** agent with `prompts/critic_generate_critique-report.md` to stress-test it.
6. If compromises are accepted, create compromise log file(s) for this step.
7. Present both the brief and critique to the user for approval.

**Human checkpoint**: User reviews and approves before proceeding to Step 2.

---

### Step 2 — PRD

|            |                                                                                    |
| ---------- | ---------------------------------------------------------------------------------- |
| **Agent**  | product-manager                                                                    |
| **Prompt** | `prompts/product_generate_prd.md`                                                  |
| **Input**  | `docs/opportunity/YYYYMMDD-<slug>.md`                                              |
| **Output** | `docs/prd/<slug>.md`                                                               |
| **Gate**   | At least 1 measurable success metric; non-goals >= 3; acceptance criteria testable |

**How to run:**

1. Use `new-doc` skill: `./scripts/new_doc.sh prd "<slug>"`
2. Invoke the **product-manager** agent with `prompts/product_generate_prd.md` and the opportunity brief as context.
3. Invoke the **critic** agent to review the PRD.
4. If compromises are accepted, create compromise log file(s) for this step.
5. Present to user. User cuts scope until it fits 1-2 weeks.

**Human checkpoint**: User approves PRD scope before proceeding.

---

### Step 3 — Spec + ADRs + Plan

|            |                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| **Agent**  | system-architect                                                                                     |
| **Prompt** | `prompts/architect_generate_spec-adrs.md`                                                            |
| **Input**  | `docs/prd/<slug>.md`, existing ADRs                                                                  |
| **Output** | `docs/spec/<slug>.md`, `docs/adr/NNNN-<decision>.md`, `plans/<slug>.md`                              |
| **Gate**   | Concrete request/response examples; >= 5 failure modes with mitigations; migration rollback strategy |

**How to run:**

1. Use `new-doc` skill for spec: `./scripts/new_doc.sh spec "<slug>"`
2. Invoke the **system-architect** agent with `prompts/architect_generate_spec-adrs.md`.
3. The agent also scaffolds ADRs (via `new-doc` skill) and the plan (via `./scripts/new_doc.sh plan "<slug>"`).
4. Invoke the **security** agent with `prompts/security_generate_threat-model.md` to review security boundaries.
5. Invoke the **critic** agent to review spec + ADRs + plan.
6. If compromises are accepted, create compromise log file(s) for this step.
7. Present to user.

**Human checkpoint**: User approves architecture decisions; rejects complexity they can't operate.

---

### Step 4 — Security Threat Model

|            |                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| **Agent**  | security                                                                                                   |
| **Prompt** | `prompts/security_generate_threat-model.md`                                                                |
| **Input**  | `docs/prd/<slug>.md`, `docs/spec/<slug>.md`, relevant ADRs                                                 |
| **Output** | `docs/security/<slug>-threat-model.md`                                                                     |
| **Gate**   | >= 5 authz threats + mitigations; sensitive data in logs addressed; rate limiting for user-facing features |

**How to run:**

1. Use `new-doc` skill: `./scripts/new_doc.sh threat-model "<slug>"`
2. Invoke the **security** agent with `prompts/security_generate_threat-model.md`.
3. If compromises are accepted, create compromise log file(s) for this step.
4. Present to user.

**Human checkpoint**: User reviews security posture.

---

### Step 5 — Test Plan

|            |                                                                       |
| ---------- | --------------------------------------------------------------------- |
| **Agent**  | qa                                                                    |
| **Prompt** | `prompts/qa_generate_test-plan.md`                                    |
| **Input**  | `docs/prd/<slug>.md`, `docs/spec/<slug>.md`, relevant ADRs            |
| **Output** | `docs/test/<slug>-testplan.md`                                        |
| **Gate**   | Every AC maps to a test; >= 3 authz tests; >= 1 rollback verification |

**How to run:**

1. Use `new-doc` skill: `./scripts/new_doc.sh testplan "<slug>"`
2. Invoke the **qa** agent with `prompts/qa_generate_test-plan.md`.
3. If compromises are accepted, create compromise log file(s) for this step.
4. Present to user.

**Human checkpoint**: User confirms test plan is runnable in <= 30 minutes.

---

### Step 6 — Build (per milestone)

|            |                                                                       |
| ---------- | --------------------------------------------------------------------- |
| **Agent**  | spec-executor                                                         |
| **Prompt** | `prompts/executor_generate-pr-ready-code.md`                          |
| **Input**  | `docs/spec/<slug>.md`, `plans/<slug>.md`, ADRs, repo codebase         |
| **Output** | Code changes, tests, updated plan task status                         |
| **Gate**   | Typecheck/lint passes; tests added for critical path; migrations safe |

**How to run:**

1. Invoke the **spec-executor** agent with `prompts/executor_generate-pr-ready-code.md`, specifying which milestone from `plans/<slug>.md` to implement.
2. The agent works through one milestone at a time in small commits.
3. If compromises are accepted during build, create compromise log file(s) for this step.
4. After each milestone, proceed to Step 7 (Review).

**Human checkpoint**: User reviews code before merging. Keep PRs small — 1 milestone per PR.

---

### Step 7 — Review

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Agent**  | reviewer                                                           |
| **Prompt** | `prompts/reviewer_generate_code-report.md`                         |
| **Input**  | PR diff, PRD, spec, plan, relevant ADRs                            |
| **Output** | Review report with verdict: MERGE / MERGE WITH COMMENTS / NO MERGE |
| **Gate**   | Treat reviewer output as a gate, not advice                        |

**How to run:**

1. Invoke the **reviewer** agent with `prompts/reviewer_generate_code-report.md` and the diff/changed files.
2. If NO MERGE: fix issues, then re-review.
3. If MERGE WITH COMMENTS: address non-blocking items, then merge.
4. For any accepted non-blocking deferrals, create compromise log file(s) for this step.
5. If MERGE: merge.

**Human checkpoint**: User makes final merge decision.

---

### Step 8 — Release

|            |                                                                       |
| ---------- | --------------------------------------------------------------------- |
| **Agent**  | spec-executor (assists with runbook/telemetry)                        |
| **Prompt** | (manual step — no dedicated prompt)                                   |
| **Input**  | Completed code, spec                                                  |
| **Output** | Updated `docs/runbook/<service>.md`, dashboards/alerts, release notes |
| **Gate**   | Can answer in 60s: Is it broken? Is it used? Is it costing money?     |

**How to run:**

1. If runbook doesn't exist: `./scripts/new_doc.sh runbook "<service>"`
2. Ensure minimum telemetry: RED metrics, business metric, audit logs.
3. If rollout compromises are accepted, create compromise log file(s) for this step.
4. Enable feature flag / execute rollout plan.

**Human checkpoint**: User owns the release. Agents assist but don't deploy.

---

### Step 9 — Retro

|            |                                      |
| ---------- | ------------------------------------ |
| **Agent**  | (human-driven; agents can summarize) |
| **Prompt** | (manual step — no dedicated prompt)  |
| **Input**  | Shipped feature, metrics data        |
| **Output** | `docs/retro/YYYYMMDD-<slug>.md`      |
| **Gate**   | None — this is reflective            |

**How to run:**

1. Use `new-doc` skill: `./scripts/new_doc.sh retro "<slug>"`
2. Fill in: did the metric move? What broke? What to automate next?
3. Reconcile open compromise logs (`plans/compromises/<slug>/`) and document closure status.
4. Update templates/gates based on pain.

---

## Running a Partial Pipeline

You don't always need to run all 9 steps. Common partial runs:

| Scenario                   | Steps to run         |
| -------------------------- | -------------------- |
| "I have an idea, scope it" | 1 → 2 (+ critic)     |
| "I have a PRD, design it"  | 3 → 4 → 5 (+ critic) |
| "Implement this milestone" | 6 → 7                |
| "Ship and retro"           | 8 → 9                |
| "Full pipeline"            | 1 → 9                |

When starting mid-pipeline, verify that prior artifacts exist. If they don't, the agent prompts will emit `BLOCKERS.md + STOP`.

## Invoking an Agent with a Prompt

The general invocation pattern:

1. Read the prompt file from `prompts/`.
2. Invoke the corresponding agent (by name from `.opencode/agent/`).
3. Pass the prompt content as the task instructions, along with any context (slug, prior artifacts).
4. The agent reads its inputs, scaffolds output via `new-doc`, and fills the template.
5. Review gate checks in the prompt. If any fail, the agent writes `BLOCKERS.md` and stops.

## Critic Pass

The critic agent can be invoked after **any** step to stress-test the output. It is most valuable after:

- Step 1 (opportunity brief) — validates the idea is worth pursuing
- Step 2 (PRD) — catches scope creep and untestable requirements
- Step 3 (spec) — finds consistency gaps between PRD and spec

Invoke with `prompts/critic_generate_critique-report.md`. The critic reads whatever artifacts exist for the slug and produces a critique report (not written to file).
