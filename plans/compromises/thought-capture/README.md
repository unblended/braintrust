# thought-capture compromise logs

Immutable, append-only compromise records for the `thought-capture` feature.

Baseline plan (immutable): `plans/thought-capture.md`

## Reconstruction note

Some records were reconstructed from available artifacts after context had partially moved on. Where exact review transcript links were unavailable, records reference the step and artifact family.

## Current records

- `20260216-step-3-v1-migration-rollback-drop-tables.md`
- `20260216-step-4-d1-extended-outage-data-loss-beta.md`
- `20260216-step-4-health-endpoint-unauthenticated-beta.md`
- `20260216-step-6-m1-local-compat-date-fallback.md`
- `20260216-step-6-m1-nodejs-compat-test-runtime.md`
- `20260216-step-6-m1-slack-webapi-fallback.md`
- `20260216-step-6-m1-wrangler-v3-update-deferred.md`
- `20260216-step-6-m5-release-readiness-remaining-deferments.md`
- `20260216-step-7-m1-review-feature-flag-defaults.md`
- `20260216-step-7-m1-review-status-changed-at-semantics.md`
- `20260216-step-7-m1-review-test-helper-sql-split.md`
- `20260216-step-7-m1-review-unbounded-unclassified-digest.md`
- `20260216-step-7-m2-review-override-rate-limiting-deferred.md`
- `20260216-step-7-m2-review-module-level-singletons.md`
- `20260216-step-7-m4-review-warnings-deferred.md`

## Usage rule

For every pipeline step, either:

1. Add one or more compromise files for accepted tradeoffs, or
2. Explicitly state "No compromises accepted" in the step output.
