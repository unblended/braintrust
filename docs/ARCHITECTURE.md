# Architecture: Agent-Team System

## Three-Layer Model

This system has three layers. Each has a distinct purpose and a clear precedence rule for output structure.

### 1. Agent Definitions (`.opencode/agent/*.md`)

Define **who** the agent is and **how** it thinks.

- Persona, philosophy, operating principles
- Core responsibilities and analysis dimensions
- Working process and constraints
- Tool permissions (via frontmatter)

Agent definitions are **stable across tasks** — they don't change per invocation.

### 2. Task Prompts (`prompts/*.md`)

Define **what** to do on a specific invocation.

- Role + objective (one-line)
- READ: required input artifacts
- WRITE: expected output artifacts
- HARD CONSTRAINTS: behavioral rules for this task
- GATE CHECKS: objective quality bars that must pass
- OUTPUT FORMAT: structural requirements

Task prompts are **task-specific** — each prompt drives one type of output (e.g., "generate a PRD," "generate a threat model").

### 3. Templates (`docs/templates/*.md`)

Define **what the output looks like** — canonical document structure.

- YAML frontmatter (`doc_type`, `date`, `owner`, `status`, `slug`)
- Section headings with placeholder content
- Token slots (`{{DATE}}`, `{{SLUG}}`, `{{TITLE}}`) replaced by `scripts/new_doc.sh`

Templates are the **source of truth** for document structure. Agents fill them; they do not redesign them.

## Precedence (for output structure)

```
Templates > Prompts > Agent Definitions
```

- If a template exists for the output type, its section headings are canonical. The agent fills them.
- If the prompt specifies additional structural constraints (e.g., "at least 5 failure modes"), those apply within the template structure.
- Agent definitions describe philosophy and rigor expectations but do **not** override template headings.

For agents that produce **ephemeral output** (no template) — critic, reviewer, spec-executor — the agent definition's output structure is canonical, and the prompt should match it.

## Invocation Pattern

```
User triggers step → Agent is invoked with task prompt → Agent reads inputs →
Agent scaffolds output via new-doc skill → Agent fills template → Gate checks run →
User reviews and approves
```

1. **Scaffold**: Use `new-doc` skill (or `scripts/new_doc.sh`) to create the file from the template.
2. **Fill**: Agent reads inputs and fills template sections per prompt instructions.
3. **Gate**: Agent self-checks against prompt's GATE CHECKS. If failed: `BLOCKERS.md + STOP`.
4. **Critique** (optional): Invoke critic agent to stress-test the output.
5. **Approve**: Human reviews and merges.

## File Naming Conventions

| Layer | Location | Naming |
|---|---|---|
| Agent definitions | `.opencode/agent/` | `<canonical-role>.md` (e.g., `product-manager.md`) |
| Task prompts | `prompts/` | `<role-prefix>_generate_<output-type>.md` (e.g., `product_generate_prd.md`) |
| Templates | `docs/templates/` | `<doc-type>.md` (e.g., `prd.md`, `spec.md`) |
| Output docs | `docs/<type>/` | See `new-doc` skill for output paths per type |
| Plans | `plans/` | `<slug>.md` |

## Agent Role Map

| Canonical Name | Agent File | Prompt(s) | Template(s) |
|---|---|---|---|
| product-manager | `product-manager.md` | `product_generate_opportunity-brief.md`, `product_generate_prd.md` | `opportunity.md`, `prd.md` |
| system-architect | `system-architect.md` | `architect_generate_spec-adrs.md` | `spec.md`, `adr.md`, `adr-light.md`, `implementation-plan.md` |
| spec-executor | `spec-executor.md` | `executor_generate-pr-ready-code.md` | (none — output is code) |
| reviewer | `reviewer.md` | `reviewer_generate_code-report.md` | (none — output is ephemeral review) |
| qa | `qa.md` | `qa_generate_test-plan.md` | `testplan.md` |
| security | `security.md` | `security_generate_threat-model.md` | `threat-model.md` |
| critic | `critic.md` | `critic_generate_critique-report.md` | (none — output is ephemeral critique) |
