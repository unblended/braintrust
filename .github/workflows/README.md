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

Configure these in GitHub Environment variables (`staging`, `production`) when needed:

- `CLOUDFLARE_D1_DATABASE_NAME` (defaults to `thought-capture-db` when empty)
- `CLOUDFLARE_WRANGLER_ENV` (for `wrangler deploy --env <name>`)
- `HEALTHCHECK_URL` (base URL; workflow checks `<base>/health`)

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
