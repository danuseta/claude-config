---
name: uat-check
description: Find the user's Qonflo (QRD) tickets in UAT MERGED, check whether their commits have actually reached origin/develop in the BE and FE repos, and move only the ones that have to UAT CHECK after the user confirms. Use when the user runs /uat-check or asks which tickets can move to UAT check.
argument-hint: "[QRD-keys...] [--move]"
disable-model-invocation: true
---

# UAT check for $ARGUMENTS

## Fixed values
- Jira site `mysales.atlassian.net`, project `QRD`, the user is assignee `M Danu Seta W`.
- Transition ids: `2` PR Review, `3` UAT CHECK, `5` UAT MERGED. Confirm with `getTransitionsForJiraIssue` on the first ticket if a move fails.
- Repos: `E:/qonflo/ms-admin-worker-backend` (BE), `E:/qonflo/ms-client-dashboard-frontend` (FE).

## Steps
1. Tickets: the keys in $ARGUMENTS, or JQL `project = QRD AND status = "UAT Merged" AND assignee = "M Danu Seta W"`. (`assignee = currentUser()` returns nothing on this connector — the MCP account is not the user's.)
2. `git -c safe.directory=* fetch -q origin develop` in both repos.
3. For each ticket and each repo: `git log origin/develop --oneline -i --grep="QRD-<n>" | wc -l`. A ticket whose summary says `[FE]` only needs FE, `[BE]` only BE, `[FE][BE]` needs both. When a count is 0 but a merged PR exists, check that PR's head with `git merge-base --is-ancestor <head> origin/develop` and say where it did land (e.g. only `feat/V1-Playbook`).
4. Show one table: ticket, summary, BE commits in develop, FE commits in develop, verdict (move / not yet + reason).
5. Move only with `--move` in $ARGUMENTS or an explicit "yes" from the user after the table: `transitionJiraIssue` with id `3`, one call per ticket, in parallel. Report each new status from the response.

## Rules
- Never move a ticket whose code is not in `origin/develop` in every repo its summary names.
- Never move anyone else's ticket.
- Answer in Indonesian, as a table.
