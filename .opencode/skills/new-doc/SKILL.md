---
name: new-doc
description: Create a new document from a project template using scripts/new_doc.sh. Use when asked to create a PRD, ADR, spec, testplan, runbook, postmortem, threat-model, retro, plan, opportunity, or compromise log doc.
---

# New Document from Template

Scaffold a new document from the project's `docs/templates/` using the `scripts/new_doc.sh` script.

## Available document types

| Type           | Template                        | Output path                                  | Extra arg     |
|----------------|---------------------------------|----------------------------------------------|---------------|
| `opportunity`  | `docs/templates/opportunity.md` | `docs/opportunity/YYYYMMDD-<slug>.md`        | —             |
| `prd`          | `docs/templates/prd.md`         | `docs/prd/<slug>.md`                         | —             |
| `spec`         | `docs/templates/spec.md`        | `docs/spec/<slug>.md`                        | —             |
| `adr`          | `docs/templates/adr.md`         | `docs/adr/<num>-<slug>.md`                   | ADR number    |
| `adr-light`    | `docs/templates/adr-light.md`   | `docs/adr/<num>-<slug>.md`                   | ADR number    |
| `testplan`     | `docs/templates/testplan.md`    | `docs/test/<slug>-testplan.md`               | —             |
| `runbook`      | `docs/templates/runbook.md`     | `docs/runbook/<slug>.md`                     | —             |
| `postmortem`   | `docs/templates/postmortem.md`  | `docs/postmortem/YYYYMMDD-<slug>.md`         | —             |
| `threat-model` | `docs/templates/threat-model.md`| `docs/security/<slug>-threat-model.md`       | —             |
| `retro`        | `docs/templates/retro.md`       | `docs/retro/YYYYMMDD-<slug>.md`              | —             |
| `plan`         | `docs/templates/implementation-plan.md` | `plans/<slug>.md`                    | —             |
| `compromise`   | `docs/templates/compromise.md`  | `plans/compromises/<slug>/YYYYMMDD-<step-tag>.md` | step tag |

## Workflow

1. **Determine the document type.** Match the user's request to one of the types above. If ambiguous, ask.

2. **Determine the slug.** Use the feature or topic name. The script normalizes it to lowercase-kebab-case automatically. Keep it short and descriptive (e.g., `offline-sync`, `billing-v2`, `rate-limiting`). For `compromise`, this slug is the feature slug whose plan stays immutable.

3. **Determine the extra argument when required.**
   - For `adr` or `adr-light`: determine the ADR number. Check existing files in `docs/adr/` to find the next available number. Format as zero-padded 4 digits (e.g., `0007`).
   - For `compromise`: provide a step tag (e.g., `step-7-m1-review`, `step-3-architecture-gap`).

4. **Run the script.**

   ```bash
   ./scripts/new_doc.sh <type> "<slug-or-title>" [extra]
   ```

   Examples:
   ```bash
   ./scripts/new_doc.sh prd offline-sync
   ./scripts/new_doc.sh adr "sync conflict resolution" 0007
   ./scripts/new_doc.sh testplan checkout-flow
    ./scripts/new_doc.sh threat-model payment-api
    ./scripts/new_doc.sh retro offline-sync
    ./scripts/new_doc.sh plan offline-sync
    ./scripts/new_doc.sh compromise offline-sync step-7-m1-review
    ```

5. **Read the created file.** The script prints the output path. Read the file to confirm it was created and tokens (`{{DATE}}`, `{{SLUG}}`, `{{TITLE}}`) were replaced.

6. **Fill in the template.** Edit the created file to populate the sections with the relevant content. Follow the structure defined in the template — do not add or remove sections unless the user requests it.

## Safe defaults

- If the user says "create a PRD" without a slug, ask for a short name.
- If the user says "create an ADR" without a number, check `docs/adr/` for the next available number.
- If the user says "log a compromise" without a step tag, ask for one (recommended format: `step-<n>-<short-title>`).
- Never overwrite an existing file — the script refuses and exits with an error. If the file already exists, inform the user and ask how to proceed.
- Always run the script from the project root directory.

## Validation

- The script exits 0 and prints `Created: <path>` on success.
- The script exits 1 with an error message if: type is unknown, template is missing, slug is empty, or output file already exists.
- After creation, read the output file and verify `{{DATE}}`, `{{SLUG}}`, and `{{TITLE}}` are no longer present (and `{{EXTRA}}` for templates that use it).

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `Template not found` | Type doesn't match a file in `docs/templates/` | Check spelling; list `docs/templates/` to see available templates |
| `Refusing to overwrite existing file` | Document already exists at that path | Use a different slug or ask the user if they want to edit the existing file |
| `Compromise logs require an [extra] step tag` | Missing step tag for `compromise` type | Re-run with a step tag, e.g. `step-7-m1-review` |
| `sed: command not found` or sed errors | macOS vs GNU sed incompatibility | The script uses `sed -i.bak` which works on both; if it fails, check the script is unmodified |
| Permission denied | Script not executable | Run `chmod +x scripts/new_doc.sh` |
