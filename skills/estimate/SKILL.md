---
name: estimate
description: Estimate story points for a Qonflo (QRD) Jira ticket with a four-factor formula (scope, complexity, uncertainty, verification) calibrated against the team's own past tickets in anchors.md. Dry-run by default; writes to Jira only with --write. Use when the user runs /estimate or asks how big a ticket is.
argument-hint: "<QRD-KEY...> [--write] | --calibrate <QRD-KEY...>"
disable-model-invocation: true
---

# Estimate $ARGUMENTS

Read `anchors.md` in this skill's folder first, so a score means what it means for this team.

## Fixed values
- Jira site `mysales.atlassian.net`. Story points field: `customfield_10016`.
- The ticket content is in custom fields, not the description: `customfield_10341` user story, `customfield_10331` problem definition, `customfield_10332` acceptance criteria. Fetch with `fields: ["*all"]`.
- Code: BE `E:/qonflo/ms-admin-worker-backend`, FE `E:/qonflo/ms-client-dashboard-frontend`. Read the Sprint 24 contract (Confluence 464945153) when the ticket is under epic QRD-1232.

## Steps
1. Fetch the ticket. Split the AC into lines.
2. Read the code it will touch (grep the symbols the ticket names; follow AGENTS.md in the workspace).
3. Score each factor 1–3 with one line that cites files or AC lines, compared against the anchors:
   - **Scope** — files, layers and components that change (FE, BE, DB, queue)
   - **Complexity** — logic and business rules, edge cases
   - **Uncertainty** — unclear AC, a dependency still in PR review, a contract § still open
   - **Verification** — tests to write, browser checks, seed data, roles
4. Total → points: 4 = 1, 5 = 2, 6–7 = 3, 8–9 = 5, 10–11 = 8, 12 = 13 (recommend a split and say where).
5. Default (dry-run): show the table and write nothing.
6. `--write`: if `customfield_10016` is empty, write the points; if it has a value, do not overwrite it — add a comment only. Comment: `Estimate: N points (Scope a + Complexity b + Uncertainty c + Verification d = total)` plus the four one-line reasons.

## Calibration (`--calibrate <keys>`)
Run steps 1–4 dry for each done ticket given. Output: key, the four scores, computed points, the points in `customfield_10016`, and the days from In Progress to Done (from the changelog). Then propose edits to `anchors.md` where score and reality disagree, and apply them only after the user agrees.

## Rules
- Never change a ticket's status. Never overwrite points a human set.
- Answer in Indonesian, as a table.
