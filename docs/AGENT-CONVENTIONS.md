# Agent Conventions (Repo Standard)

## Output format

- Agents produce Markdown files using templates in `docs/templates/`.
- Agents prefer minimal prose, explicit lists, and concrete acceptance criteria.
- Agents must keep "Open questions" at 0 before implementation begins.

## Requirement keywords

Use RFC 2119-style keywords consistently in specs:

- MUST, MUST NOT, SHOULD, SHOULD NOT, MAY

## Gate checks (what agents should verify)

- PRD: success metric + non-goals + acceptance criteria present
- Spec: invariants + API schemas + failure modes + rollout + observability present
- ADR: context + decision drivers + options + consequences present
- Test plan: happy path + 5 edge cases + regression list present
- Runbook: triage + mitigations + rollback present

## Change discipline

- Agents do not merge to main.
- Agents propose diffs/patches and include a short "risk list" in PR description.
