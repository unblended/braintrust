#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/new_doc.sh prd offline-sync
#   ./scripts/new_doc.sh adr "sync conflict resolution" 0007
#
# Creates a new doc from `docs/templates/<type>.md` into the proper folder.

TYPE="${1:-}"
SLUG="${2:-}"
EXTRA="${3:-}"

if [[ -z "${TYPE}" || -z "${SLUG}" ]]; then
  echo "Usage: $0 <type> <slug-or-title> [extra]"
  echo "Types: opportunity prd spec adr adr-light testplan runbook postmortem threat-model retro plan"
  exit 1
fi

if [[ "${TYPE}" == "plan" ]]; then
  TEMPLATE="docs/templates/implementation-plan.md"
else
  TEMPLATE="docs/templates/${TYPE}.md"
fi
if [[ ! -f "${TEMPLATE}" ]]; then
  echo "Template not found: ${TEMPLATE}"
  exit 1
fi

today="$(date +%Y%m%d)"
safe_slug="$(echo "${SLUG}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g' | sed -E 's/^-+|-+$//g')"

case "${TYPE}" in
  opportunity)
    OUT="docs/opportunity/${today}-${safe_slug}.md"
    ;;
  prd)
    OUT="docs/prd/${safe_slug}.md"
    ;;
  spec)
    OUT="docs/spec/${safe_slug}.md"
    ;;
  adr|adr-light)
    num="${EXTRA:-0000}"
    OUT="docs/adr/${num}-${safe_slug}.md"
    ;;
  testplan)
    OUT="docs/test/${safe_slug}-testplan.md"
    ;;
  runbook)
    OUT="docs/runbook/${safe_slug}.md"
    ;;
  postmortem)
    OUT="docs/postmortem/${today}-${safe_slug}.md"
    ;;
  threat-model)
    OUT="docs/security/${safe_slug}-threat-model.md"
    ;;
  retro)
    OUT="docs/retro/${today}-${safe_slug}.md"
    ;;
  plan)
    OUT="plans/${safe_slug}.md"
    ;;
  *)
    echo "Unknown type: ${TYPE}"
    exit 1
    ;;
esac

mkdir -p "$(dirname "${OUT}")"

if [[ -f "${OUT}" ]]; then
  echo "Refusing to overwrite existing file: ${OUT}"
  exit 1
fi

cp "${TEMPLATE}" "${OUT}"

# Simple token replacements
sed -i.bak \
  -e "s/{{DATE}}/${today}/g" \
  -e "s/{{SLUG}}/${safe_slug}/g" \
  -e "s/{{TITLE}}/${SLUG}/g" \
  "${OUT}"
rm -f "${OUT}.bak"

echo "Created: ${OUT}"
