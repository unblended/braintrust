
---
doc_type: spec
date: {{DATE}}
owner: you
status: draft
slug: {{SLUG}}
---

# Engineering Spec: {{TITLE}}

## Context
Link to PRD: `docs/prd/{{SLUG}}.md`

## Goals / non-goals
- Goals:
- Non-goals:

## Proposed architecture (high level)
- Components:
- Data flows:
- Key abstractions:

## Data model
### Entities / tables
- Entity:
  - Fields:
  - Invariants:
  - Indexing:

### Migrations
- Backward compatibility:
- Rollback strategy:

## API design
### Endpoints / operations
For each:
- Method + path (or operation name):
- AuthZ rules:
- Request schema:
- Response schema:
- Errors:
- Idempotency strategy:

## Consistency & concurrency
- Conflict resolution rules:
- Ordering guarantees:
- Retries and idempotency keys:

## Failure modes (top 5)
1.
2.
3.
4.
5.

## Security
- Threat model link: `docs/security/{{SLUG}}-threat-model.md`
- Data classification:
- Secrets handling:
- Audit logging:

## Performance & cost
- What scales with users?
- Expected hot paths:
- Limits/quotas:

## Observability
- Logs (key events):
- Metrics (RED + business metric):
- Traces (optional):
- Alerts:

## Rollout / delivery plan
- Feature flags:
- Backfill jobs:
- Phased rollout:
- Rollback plan:

## Testing strategy
- Unit:
- Integration:
- E2E:
- Load-ish test:
