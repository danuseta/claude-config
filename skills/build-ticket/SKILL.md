---
name: build-ticket
description: Use when implementing a Qonflo ticket. Loads the fixed build order so no step is skipped - orient before writing, reuse before inventing, verify in a browser before claiming done.
---

# Implement a Qonflo ticket

Create one todo per step below before starting. Do not collapse steps.

## Paths on this machine

The same skill runs on the Windows laptop and the Linux workspace. Every path below comes from the kit; resolve them once at the start:

```
node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/paths.cjs" --print
```

It prints JSON. Use its `root` (work root holding the app repos), `evidence` (the blackboard and ledger folder), `kitDir` and `configDir` wherever `<root>`, `<evidence>`, `<kitDir>` or `<configDir>` appear below. Python is `python3` on Linux and `python` on Windows.

## 1. Read the rules

`AGENTS.md` at `<root>`, plus the `CLAUDE.md` of the repo being touched. Both carry constraints the code does not state.

## 2. Contract, then prior decisions

One ticket per session.

First apply `<configDir>/rules/ticket-contract.md`: find and read the ticket's contract before anything else. When the contract is found but cannot be read, stop there and report.

Then read the sprint blackboard and this ticket's ledger entry. Where the blackboard disagrees with the contract, the contract wins; record the difference with `status.cjs decide`. `sprint.md` is the index (sources, standing rules, ticket table); open `sprint-contract.md`, `sprint-artifacts.md` or `sprint-open.md` beside it only for the part this ticket needs.

```
<evidence>/sprint.md
node "<kitDir>/status.cjs" show <KEY>
```

```
python3 "<kitDir>/brain.py" retrieve "<ticket keywords>"
```

`kit/brain.py` arrives with a later step of the kit. Until `<kitDir>/brain.py` exists, run the same `retrieve` subcommand on the `brain.py` that the UserPromptSubmit retrieval hook in `<configDir>/settings.json` already calls; when neither is present, rely on the hook's automatic block and say that retrieval was not run.

Read the two or three closest notes. The automatic block on each prompt matches on keywords alone and often misses.

## 3. Blast radius

```
graphify query "<what the change touches>"
```

Find what already exists before writing anything new. Layout maths, traversals, shared constants - this project has more of them than a grep suggests.

## 4. Ticket and design

Fetch the Jira issue through the Atlassian MCP.

For a Figma link, try the file referenced in the ticket itself, not only the one pasted in chat. Ticket links are usually shared with the MCP account when a pasted one is not.

`get_metadata` gives exact coordinates and spacing. Compare those against the constants already in the code before inventing new ones.

## 5. Branch

Cut from `origin/develop`, never from the branch currently checked out.

## 6. Write

Hand the writing to a Sonnet subagent (`oh-my-claudecode:executor`) with the ledger brief as its prompt; this session reviews. Record each choice with `node "<kitDir>/status.cjs" decide <KEY> "<what and why>"`, and the subagent's report with `status.cjs handoff <KEY> <name> status=.. summary=.. evidence=.. unverified=..`: the ledger refuses a PASS before a handoff exists and refuses one whose evidence is not a file that exists.

- no explanatory comments, no JSDoc, none in tests
- smallest possible diff
- do not widen a type, rename a variable, or change behaviour outside the ticket
- extend with an optional argument that defaults to today's behaviour rather than changing a shared function

## 7. Verify

```
npx tsc --noEmit
npx eslint <only the files touched>
npx vitest run src/v2/modules/<module>
```

Run the whole module, not just the new test. Report the count before and after.

Before shipping, one `oh-my-claudecode:code-reviewer` (Opus) pass on the full diff, with the brief and the `graphify query` output.

## 8. Verify in a browser for UI work

Seed the data straight into local Mongo, then drive Playwright: log in, open the page, click the thing, read the result out of the DOM.

Playwright lives in the scratchpad, never in the repo. Screenshots go to the day's folder, `<root>/<MMDD>/qrd-<n>/` (month and day they were taken, lowercase ticket, e.g. `<root>/1006/qrd-1393/`), numbered and named for what they show. Dark mode is mandatory for every screenshot (Playwright `colorScheme: "dark"` plus localStorage `v2-theme=dark`), file name ending `-dark.png`. A `-light.png` is only ever an extra next to its dark twin, taken when the AC names light mode or the owner asks; what is shown or sent to anyone is the dark one. `<evidence>/<KEY>/` keeps only the ledger, logs, scripts, video and caches.

Unit tests do not catch an unreadable button.

## 9. Ship

Commit, push, give the compare link. Nothing else.

In a DOCK chat turn (`DOCK_CHAT_TURN=1`: the orchestrator cron or the owner chatting from DOCK) nobody is at the terminal to open the pull request, so open it yourself and then stop. The base is `develop` unless the start prompt names another one (a V1 Playbook ticket, epic QRD-1232, goes to `feat/V1-Playbook`):

```
rtk gh pr create --base <base> --head <work branch> --fill
node "<kitDir>/status.cjs" set <KEY> stage=pr waiting="PR open: waiting for the owner's review"
```

Set the stage and the waiting text in that one command, after the pull request exists. Then end the turn. The owner will ask in the chat whether the work follows the ticket and the contract and, for UI work, whether it was checked in a browser. Answer from the ledger and the evidence. Make the demo video (`demo-video` skill) only after the owner approves in that chat, never before.

### DOCK turns: one ticket, no asking on a ticket with acceptance criteria

- A DOCK session works on this ticket only. A request about another ticket belongs in its own DOCK session; say so instead of starting it here.
- When the ticket has acceptance criteria, do not stop to ask. On an ambiguity, take the reading closest to the AC, record it with `status.cjs decide <KEY> "<what and why>"`, and go on.
- Stop and ask only when you cannot go on without the owner: missing access or token, the environment is down, a prerequisite ticket is not done. Say which. A question you still have may go with the PR message instead.
- After the pull request exists, append a section "Decisions taken without the owner" to its body (`rtk gh pr edit <n> --body-file <file>`, the file being the current body plus the section), one line per `decide` entry. Repeat the same list in your last chat message.

## 10. Queue the note

```
python3 "<kitDir>/brain.py" save --no-ingest --project "qonflo" --topic "<topic>" --title "<title>" --context "<why>" --point "<point>" --decision "<outcome>"
```

Until `<kitDir>/brain.py` exists, run the same `save` subcommand on the `brain.py` the retrieval hook calls (see step 2).

## Never

Do not draft a PR description. The exceptions are the `Contract:` line and quotes that `rules/ticket-contract.md` requires, and the "Decisions taken without the owner" section a DOCK turn appends (section 9).
