---
name: orchestrate
description: Run one Qonflo (QRD) ticket per session end to end as an orchestrator - gate, isolated worktrees and ports, plan, implementation, tests, browser verification, evidence - stopping only at the user's three decision gates (plan, evidence, commit). Also answers "status" with the ledger of every ticket. Use when the user runs /orchestrate, asks to work or resume a ticket, or asks where each ticket stands.
argument-hint: "<QRD-KEY> | status"
---

# Orchestrate $ARGUMENTS

Building a ticket runs through the `sous` skill: load it and follow it. A ledger with `engine=sous` belongs to that flow; continue it there. This skill keeps `status` and the tickets the old flow already started.

The user is the manager. They decide at three gates and nowhere else: **plan**, **evidence**, **commit**. Everything between gates runs without them. Everything stays local: nothing is committed or pushed without an explicit go.

## One session, one ticket - and it starts from the blackboard
A session carries every earlier turn on every later turn, so a second ticket in the same session pays for the first one again on each turn. Work one ticket per session, from gate to PR. Asked for a second ticket, finish or park the current one in the ledger and tell the user to open a new session with `/orchestrate <KEY>`; do not restart a session in the middle of a ticket either.

The first two reads of every session, before Jira, Confluence, an artifact or the repo:
1. `E:/qonflo/.evidence/sprint.md` - the sprint blackboard index: sources, standing rules and the ticket recap. The shared contract (`sprint-contract.md`), the map of where each ticket lives in the four artifacts (`sprint-artifacts.md`) and the open conflicts plus `UNVERIFIED` (`sprint-open.md`) sit beside it; open one only for the part this ticket needs.
2. `node $K/status.cjs show <KEY>` - this ticket's stage, AC, `brief` and `decisions`.
3. One Jira call for the ticket's `updated` time and its AC field, the AC written to a file one capability per line, then `node $K/status.cjs stale <KEY> <updated> @<file>`. FRESH: carry on. STALE: the ledger now refuses PASS and `done`; tell the user what changed, run `ac-set` again and re-check the rows that moved. UNSTAMPED: run `ac-set` first.

Then continue from the recorded stage. Open a source only for what the blackboard cannot give: the ticket's own Jira fields at the gate, and the exact artifact section or contract paragraph that the blackboard files point at, to quote the sentence that decides something. Do not re-read a whole artifact or the whole contract. If `sprint.md` is missing, or its "Rebuild when" line applies (contract version changed, sprint plan changed, new sprint), say so and rebuild it in a session of its own before working a ticket: a stale blackboard is worse than none.

Write back as you go, not at the end:
- `node $K/status.cjs brief <KEY> @<file>` once the gate says GO: scope, the AC checklist one capability per line, base branch, entry points and files to touch, the contract clauses that bind it with their section numbers, behaviour that must not change. Every member prompt is built from this brief, so no member rediscovers the ticket.
- `node $K/status.cjs ac-set <KEY> @<file> <jira updated>` before anyone is spawned on the ticket: the AC rows come from Jira, one capability per line, written by the lead. Members have no Jira access and never invent rows; the ledger locks the row count, so a row that is not in Jira cannot be added.
- `node $K/status.cjs assume <KEY> "<assumption>" "<what would prove it wrong>"` for anything taken as true without a quote or a check, and `assume <KEY> <n> confirmed|refuted "<evidence>"` when it is settled. An assumption stays an assumption until evidence or an owner decision changes its label.
- `node $K/status.cjs decide <KEY> "<what was decided and why>"` for every decision: each gate answer from the user, a design choice between alternatives, a deviation from the plan, a finding parked for later. Decisions are appended, never rewritten.

## This session is the lead; who coordinates depends on how many tickets it holds
Owner decision 2026-10-08: a second Opus context per ticket only pays for itself when the lead holds more than one ticket.

```
One ticket in the session (the normal case)
Lead (this session)            talks to the user, owns the gates, the kit scripts and git, and coordinates the ticket itself
 └─ Members                    do the hands-on work: explore, plan, code, test, verify

Two or more tickets in the session
Lead (this session)            talks to the user, owns the gates, the kit scripts and git
 └─ Sub-coordinator per ticket the lead's deputy: splits the work, spawns the team, reads their reports
     └─ Members                 do the hands-on work
```

"The coordinator" below means the lead when the session holds one ticket, and that ticket's sub-coordinator otherwise. A light request about a ticket (its status, whether it can be worked on, re-reading one source) is answered by the lead directly, without a spawn. DOCK follows both shapes: it shows a ticket without a sub-coordinator as "lead direct", and maps each member to its ticket from the ticket key in the spawn's `description`, so every spawn the lead makes must carry `QRD-<n>` there.

**The lead**, with one ticket, spawns the members from the table below itself (Sonnet members, `explore` on Haiku, `planner` and `code-reviewer` on Opus) and reads their reports. With two or more tickets it spawns exactly one sub-coordinator per ticket and only reads each verdict, re-checking the sentence that decides it. Either way the gate runs through the `ticket-gate` skill (all four sources: Jira, the contract, the sprint plan artifact, the repos), the lead runs `prep-ticket.sh` once the gate says GO, presents the three gates to the user, and after GATE 3 stages, commits and pushes. It does not edit application code, run test suites or drive the browser itself.

**The sub-coordinator** is spawned with the Agent tool as `subagent_type: "oh-my-claudecode:executor"`, `model: "opus"`, `name: "coord-<n>"`, `description: "QRD-<n> coordinator"`. Its prompt carries the ticket's brief from the ledger, the AC checklist, the worktree paths and ports, this whole "members" table and the rules below. It spawns OMC members as needed (the `oh-my-claudecode:team` routing, in this session, without `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), keeps the ledger's stage current with `node $K/status.cjs set <KEY> stage=<stage>`, and never edits application code itself. It stops and reports to the lead at each gate (plan ready, evidence ready, ready to commit) and whenever it is blocked; the lead continues it with SendMessage once the user has decided.

| Stage | Members the coordinator spawns (`subagent_type`) | Notes |
|---|---|---|
| `plan` | `oh-my-claudecode:explore`, then `oh-my-claudecode:planner` | add `oh-my-claudecode:analyst` when the AC is unclear; the planner follows the project's `build-ticket` skill up to its plan |
| `code` | one `oh-my-claudecode:executor` per independent piece (BE and FE are separate pieces; split further by file ownership) | `oh-my-claudecode:designer` for UI-heavy pieces, `oh-my-claudecode:debugger` for build or type errors |
| `test` | `test-runner` per touched worktree | new tests are written by `oh-my-claudecode:test-engineer` |
| `verify` | `browser-verifier` (dry run), then `oh-my-claudecode:verifier` on the AC-to-code table, then always one `oh-my-claudecode:code-reviewer` (Opus) on the full diff | the reviewer gets the brief, the AC table and `graphify query` output for the blast radius, and its findings are fixed or answered before GATE 2; add `oh-my-claudecode:security-reviewer` for auth or secrets |
| fix round | `oh-my-claudecode:executor` (or `debugger`) on exactly what failed | set the ledger back to `code`; DOCK shows this as a new round |

A review of a teammate's PR runs the same way with `node $K/status.cjs set <KEY> kind=review`: the coordinator spawns one `oh-my-claudecode:code-reviewer` and one `test-runner` per PR, plus a member for screenshots when there is a frontend. The project's `review-pr` skill still governs what counts as a blocker and how the verdict is written.

Rules for every spawn, at both levels:
- Spawn members that can run at the same time in **one** message, each with a distinct `name` (`be-exec`, `fe-exec`, `be-tests`) and a 3-5 word `description`. The lead's spawn must name the ticket key in the description; DOCK maps that agent (a member, or a sub-coordinator) to its ticket from that, and a sub-coordinator's members follow it automatically. DOCK shows the name and the description, nothing else.
- Name the worktree path and the ports in every prompt. Members run in the lead's folder, not in the worktree, so each must be told where to work.
- A member's prompt carries the constraints it cannot see: smallest diff, no comments added, no commit, no push, no package install, no lint, never touch another directory, report as a table of `path:line` and results rather than logs.
- Two members never own the same file. If two pieces need one file, make it one piece.
- The lead verifies the top findings of any report itself before repeating them to the user.

## A report is a handoff, and "done" alone is not one
Every member's prompt ends with this block, and every member's reply ends with it filled in:

```
status:      done | partial | blocked
summary:     one or two sentences
evidence:    a file path that exists, or the command and its output
where:       the files or folder holding the result
assumptions: what was taken as true without checking
open:        questions it could not answer
unverified:  what was not checked ("none" only when everything was)
```

The coordinator records each one before it acts on it: `node $K/status.cjs handoff <KEY> <member name> status=.. summary=.. evidence=.. where=.. assumptions=.. open=.. unverified=..` (or `@<file.json>`). The ledger enforces the rest, not this text:
- evidence that is empty, says "pending", or names a path that does not exist is stored as UNPROVEN. Pass that claim up as "belum diverifikasi", or check it yourself and record a new handoff. Never repeat it as done.
- `ac <KEY> <n> PASS` is refused without evidence that exists, and refused before any handoff is recorded.
- `set <KEY> stage=done` is refused while a member's latest handoff is unproven.

## When something fails
Name the kind of failure before choosing what to do: `node $K/status.cjs fail <KEY> <type> "<command and output>" "<what failed>"`. Use the same "<what failed>" text when the same thing fails again; that is how attempts are counted.

| Type | It is this when | What happens next |
|---|---|---|
| `transient` | a timeout, a port not up yet, a network blip that would not repeat by itself | retry, at most twice; the third is refused |
| `defect` | the code is wrong: a failing test, a type error, a FAIL in the browser | fix round on exactly what failed |
| `spec` | the AC, the contract and the wireframe disagree, or the AC is silent | stop, take both texts to the user |
| `env` | the stack, a login state, a missing package, a stale cache | fix the environment, leave the code alone |
| `permission` | a 401 or 403, a tool the member lacks, an action only the user may take | stop and ask; never read it as a verdict on the code |

A non-transient failure that comes back after one fix is refused with exit 2: check the assumptions or escalate, do not try a third method. A change of plan (a piece re-split, a different approach, a task added) is `node $K/status.cjs replan <KEY> "<reason>"`; the budget is 2 unless the gate set `replanBudget`, and past it the ledger refuses and parks the ticket for the user.

Kit: `K=C:/Users/danus/.claude-kantor/kit`. Screenshots go to the day's folder, `E:/qonflo/<MMDD>/qrd-<n>/` (month and day they were taken, lowercase ticket, e.g. `E:/qonflo/1006/qrd-1393/`), numbered and named for what they show. Dark mode is mandatory for every screenshot (Playwright `colorScheme: "dark"` plus localStorage `v2-theme=dark`), file name ending `-dark.png`. A `-light.png` is only ever an extra next to its dark twin, taken when the AC names light mode or the owner asks; what is shown or sent to anyone is the dark one. `E:/qonflo/.evidence/<KEY>/` keeps only the ledger, logs, scripts, video and caches. Ledger: `node $K/status.cjs` (table), `show KEY`, `set KEY stage=... waiting="..."`, `ac-set KEY @file <jira updated>`, `ac KEY n STATE "note" "evidence"`, `stale [KEY <jira updated> @file]`, `handoff KEY who k=v...`, `fail KEY type "evidence" "what"`, `assume KEY "text" "falsifier"`, `replan KEY "reason"`, `finding KEY "text"`, `metrics`, `brief KEY @file`, `decide KEY "text"`. A refusal prints `REFUSED` and exits 2: do what it says, do not edit `status.json` by hand to get past it. `sync [KEY]` pulls PR state from GitHub (fills `pr.be`/`pr.fe`, `commit` -> `pr` when a PR exists, `pr` -> `done` when every PR is merged); a SessionStart hook runs it, so do not set those by hand. AC text and PASS/FAIL are never synced: the rows come from `ac-set`, one row per capability, states `PASS`, `FAIL` or `TODO` only.

## `status`
Print `node $K/status.cjs`, then for every ticket with a non-empty "waiting" say what decision is needed. Nothing else.

## Per ticket - the pipeline
Update the ledger at every stage change, and set `waiting` whenever the ticket stops for the user. Clear it (`set <KEY> waiting=`) the moment work on the ticket resumes, for any reason including a video or a re-check: DOCK shows a ticket with a non-empty `waiting` as parked at a gate and ignores its agents' activity until it is cleared. That ledger is what survives a lost context: on resume, read it first and continue from the recorded stage instead of starting over.

| Stage | What runs | Stops for the user? |
|---|---|---|
| `gate` | the coordinator runs the `ticket-gate` skill; with a sub-coordinator, the lead re-checks the deciding quote | only on ASK FIRST / NO-GO |
| prep | `bash $K/prep-ticket.sh <KEY> <slug> <be-base or -> <fe-base or -> "<title>"` - worktrees `E:/qonflo/wt-<n>-be|fe` through `wt.sh` (the FE one gets its own `node_modules` from the pnpm store, the BE one a junction), ports 31xx / 52xx, ledger entry | no |
| `plan` | members: `explore` then `planner`, following the project's `build-ticket` skill up to its plan (AC checklist, entry points, files to touch, the split into pieces and who owns which file) | **GATE 1: approve the plan** |
| `code` | members: one `executor` per piece, inside the ticket's worktree only, smallest diff, no comments added | no |
| `test` | the `test-runner` agent on each touched worktree; REAL failures go back to `code` | no |
| `verify` | `bash $K/stack.sh up <KEY> <be-dir> <fe-dir> <be-port> <fe-port>`; if `E:/qonflo/.playwright/cli-<fe-port>.json` is missing, ask the user to run `login-state.cjs` once; then the `browser-verifier` agent in dry-run, the `verifier` member on the AC table, and the `code-reviewer` (Opus) on the diff. A FAIL or an unanswered review finding goes back to `code` as a fix round | no |
| `evidence` | one table: every AC line with its `path:line`, its test, and its screenshot or "BE-only, proven by <test>"; then `git status --short` and `git diff --stat` per worktree, and remove anything not required by an AC | **GATE 2: check the evidence** |
| `commit` | stage per path (never `git add .` / `-A`), commit `QRD-<n> <type>: <subject>`, push the branch, give the compare link | **GATE 3: explicit go** |
| `pr` / `done` | `browser-verifier` in record mode for the final video, once, only after a fully passing dry run (no re-record loop; any TTS is generated in one call); PR only when asked; `stack.sh down` the ticket's ports. A reviewer's finding on the open PR is recorded with `status.cjs finding <KEY> "<text>"`. Reaching `done` writes the closing numbers (fix rounds, failures per type, replans, hours); `status.cjs metrics` prints them per ticket and per work type | no |

A line of the AC with no `path:line` and no evidence means the ticket is not at `evidence` yet, however much else works.

## Keeping the session small
- A sub-coordinator, when the session holds two or more tickets, runs on Opus (owner's instruction, 2026-10-06: it reads sources, judges reports and decides what is a finding, and on Sonnet it stopped on a wrong reading of a 401, reported an untouched repo that was damaged, and needed the lead to redo its checks). Members run on Sonnet (`executor`, `verifier`, `test-runner`, `browser-verifier`), search on Haiku (`explore`); the plan (`planner`) and the final review (`code-reviewer`) run on Opus. Do not override a member to Opus "to be safe".
- Sub-coordinators and members never commit, push, install packages or run lint. They report; this session decides.
- Keep this session's context for decisions: members and sub-coordinators return tables and file paths, not logs or diffs.
- Several tickets means several sessions, each its own lead with its own worktrees and ports; `status` in any of them shows all tickets.

## Never
- Ports 3000, 3001, 5173 (the user's own servers) - `stack.sh` refuses them.
- `git worktree add` or `git worktree remove` called directly, and `rm -rf` on a `wt-*` folder. Worktrees are added and removed with `bash $K/wt.sh add|unlink|remove`: `remove` refuses while a `node_modules` junction is attached (`unlink` first) and checks the main repo's `node_modules/.bin` afterwards. The `guard.cjs` hook refuses the direct forms for the lead and for every member.
- Arguing with the guard hook or working around it (`git add .`, a push to `develop` / `main` / `master`, a kill aimed at port 3000 / 3001 / 5173). Its message names the supported way; take it.
- Committing `docs/`, `.gitignore`, `.omc/`, or any AI attribution trailer.
- Treating a merge conflict as a blocker in a review, or calling a UI finding a blocker before checking the wireframe.
- Starting a ticket whose gate said ASK FIRST or NO-GO.
- A second ticket in this session, or a decision left out of the ledger.

Answer in Indonesian, tables over prose.
