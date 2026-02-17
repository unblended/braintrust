# GitHub Actions Deployment Setup

These workflows deploy the `thought-capture` Worker via Wrangler and always run D1 migrations before deployment.

## Workflows

- `ci.yml`: Test and build on pull requests and pushes to `main`.
- `deploy-staging.yml`: Deploys to staging after CI succeeds on `main` (or manually).
- `deploy-production.yml`: Manual production deployment.
- `rollback-production.yml`: Manual production rollback to a specific Worker version.
- `deploy-worker.yml`: Reusable deployment job shared by staging and production.

## Required Secrets

Configure these secrets in GitHub (repository or environment scope):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Optional Environment Variables

Configure this in GitHub Environment variables (`staging`, `production`) when needed:

- `HEALTHCHECK_URL` (base URL; workflow checks `<base>/health`)

Note: staging and production workflows now set `d1_database_name` and `wrangler_environment` explicitly (`thought-capture-db-staging`/`staging` and `thought-capture-db-production`/`production`) to avoid accidental default-environment deploys.

## Recommended GitHub Environment Protections

Set these in repository settings for `production`:

- Required reviewers
- Deployment branch restrictions
- Optional wait timer

## Deployment Order Guarantee

`deploy-worker.yml` executes:

1. `wrangler d1 migrations apply ... --remote`
2. `wrangler deploy ...`

This enforces migrations before Worker rollout.
