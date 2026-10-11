---
name: ticket-gate
description: Pre-flight gate for a Qonflo (QRD) ticket before any code is written - checks the ticket against the sprint contract, its blockers, the sprint plan and existing branches or PRs, and answers GO, ASK FIRST or NO-GO with the quoted text that decides it. Use at the very start of build-ticket or /orchestrate, and whenever the user asks "can this ticket be worked on now?".
argument-hint: "<QRD-KEY>"
---

# Ticket gate for $ARGUMENTS

A ticket that is forbidden this sprint, blocked, or already half-built elsewhere must be caught here, not in review. QRD-1387 is the reason this skill exists: it was built from the sprint plan alone, and only later did the contract's §6.3 turn out to list it under "not built this sprint".

## Sources, in the contract's own precedence order
Start from `E:/qonflo/.evidence/sprint.md` (the sprint blackboard) and `node C:/Users/danus/.claude-kantor/kit/status.cjs show <KEY>`. The blackboard tells you where to look; it is never the quoted source. Jira (1) and the repos (4) are always read live. For the contract (2) and the sprint plan (3), open the live source at the section the blackboard points to and quote from there, instead of reading either end to end. If the blackboard is missing, does not mention the ticket, or its "Rebuild when" line applies, read sources 2 and 3 in full and report that the blackboard needs a rebuild.

1. **Jira** (`mysales.atlassian.net`) - fetch with `fields: ["*all"]`. The content lives in custom fields: `customfield_10341` user story, `customfield_10331` problem, `customfield_10332` acceptance criteria, `customfield_10020` sprint, `issuelinks` blockers.
2. **The working contract** of the ticket's epic. For epic QRD-1232 it is Confluence page `464945153`; for another epic search Confluence for `working contract <EPIC-KEY>`. No contract found is a finding, not a pass.
3. **The sprint plan** linked from the contract (an artifact; read it with the Artifact tool).
4. **The repos** - `gh pr list --search "<KEY>" --state all` in `E:/qonflo/ms-admin-worker-backend` and `E:/qonflo/ms-client-dashboard-frontend`, plus `git branch -a --list "*<KEY>*"`.

## Checks - answer each with a verbatim quote or "not mentioned"
| # | Check | Fails the gate when |
|---|---|---|
| 1 | Sprint membership and status in Jira | not in the active sprint, or already In Progress under someone else |
| 2 | The contract's committed list (§2) | the ticket is absent AND the contract says who must be asked first |
| 3 | The contract's "not built this sprint" list (§6.3) and its closing "outside the committed" paragraph (§9) | the ticket or its feature is named there |
| 4 | Frozen interfaces (§4) and rulings (§5) that name the ticket | an AC line contradicts one - list both texts |
| 5 | Open questions (§8) with a named sign-off that this ticket depends on | the sign-off is not recorded |
| 6 | Blockers (`is blocked by`) and the sprint plan's `dep` | a blocker is not at least in PR Review, or its code is not on a reachable branch |
| 7 | Existing branch or PR for this key | work already exists - reuse it, never start a second branch |
| 8 | AC completeness | AC is empty, or a line names a capability with no observable outcome |

Split the AC into one line per capability while you read it: a comma-separated list is N lines.

## Work type, assumptions and discovery
Before the verdict, say which kind of work this is and record it with `status.cjs set <KEY> type=<type>`:

| Type | It is this when | Consequence |
|---|---|---|
| `procedure` | the same kind of change has been built here before and every AC line can be checked as written | straight to plan |
| `project` | the deliverable is clear but part of the way to build it is not known yet | plan the nearest piece in detail, keep the rest rough |
| `discovery` | an AC line cannot be given a check until a fact is known | the fact is found first, as its own task |

Anything the gate takes as true without a quote or a check is an assumption, not a fact: `status.cjs assume <KEY> "<assumption>" "<what would prove it wrong>"`.

A missing fact becomes a discovery task, written down before any code: the question, the inputs to use (branch, endpoint, artifact section), the evidence to bring back, when to stop, and that it changes nothing. Its answer comes back to this gate, where it either becomes the check for the waiting AC line or changes the verdict. A missing decision is not a discovery task: that is ASK FIRST.

## Verdict
- **GO** - every check passes. Give the base branch to cut from and the AC checklist. A `discovery` ticket gets GO for its discovery task only, and returns here with the evidence.
- **ASK FIRST** - sources disagree (e.g. the sprint plan schedules it, the contract forbids it), a sign-off is missing, or a blocker is still moving. Write the one message the user can send to the contract owner, quoting both texts. Never resolve a disagreement yourself: a rejected or forbidden design is not approved by inference.
- **NO-GO** - explicitly forbidden with no conflicting source, or blocked by work that does not exist yet.

## Output
One table (check, result, quoted source), the verdict, then the AC checklist. Record it:
`node C:/Users/danus/.claude-kantor/kit/status.cjs set <KEY> stage=gate waiting="<what the user must decide, or empty>"`
(run `status.cjs init` first if the ticket has no ledger yet). On GO write the AC checklist to a file, one capability per line, and run `status.cjs ac-set <KEY> @<file> <the Jira "updated" time>`: that fills the AC rows, locks their count and stamps the source so a later Jira edit is caught by `status.cjs stale`. Set `replanBudget` with `status.cjs set <KEY> replanBudget=<n>` when 2 is wrong for this ticket. Also save the brief with `status.cjs brief <KEY> @<file>` (scope, AC checklist, base branch, binding contract clauses with section numbers, behaviour that must not change), and on ASK FIRST record what was asked with `status.cjs decide <KEY> "..."`. Answer in Indonesian.
