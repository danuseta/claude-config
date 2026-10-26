---
name: review-pr
description: Use when reviewing a Qonflo pull request. Loads the fixed review order so no step is skipped - ticket first, then diff, then verify every claim against the real code, then check the recurring reviewer patterns.
---

# Review a Qonflo PR

Create one todo per step below before starting. Do not collapse steps.

## Paths on this machine

The same skill runs on the Windows laptop and the Linux workspace. Every path below comes from the kit; resolve them once at the start:

```
node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/kit/paths.cjs" --print
```

It prints JSON. Use its `root`, `evidence`, `kitDir` and `configDir` wherever `<root>`, `<evidence>`, `<kitDir>` or `<configDir>` appear below. Python is `python3` on Linux and `python` on Windows.

`kit/brain.py` arrives with a later step of the kit. Until `<kitDir>/brain.py` exists, run the same subcommand (`retrieve`, `save`) on the `brain.py` that the UserPromptSubmit retrieval hook in `<configDir>/settings.json` already calls; when neither is present, rely on the hook's automatic block and say that retrieval was not run.

## 0. Prior reviews

```
python3 "<kitDir>/brain.py" retrieve "review PR verdict"
```

Read the two or three closest ones. Carry forward what they settled: an objection that keeps coming back, a verdict that had to be corrected, a check that caught a real defect. Name in the report what this review inherited from them.

## 1. Ticket and contract

Apply `<configDir>/rules/ticket-contract.md` first: find and read the ticket's contract. When the contract is found but cannot be read, stop and report; do not give a verdict without it.

Fetch the Jira issue through the Atlassian MCP. Read the whole description, not the summary.

Record: issue type, status, assignee, every distinct scope in the description, and whether the Key details fields are filled.

A ticket description can be stale. If it names a second scope, check whether that scope was already fixed elsewhere before treating it as missing.

When the review comes with a Discord thread (the pr-review thread, or a bug or UAT thread the PR answers), read it as part of the ticket: `node "<kitDir>/discord-files.cjs" <link or thread id> "<evidence>/<MMDD>/<KEY>-discord"` prints every message and saves every file. Read the saved files (a PDF with the Read tool). What the thread asks for counts as scope next to the description. Only when the script itself fails, name its error in the report.

## 2. Diff

```
gh pr view <n> --json title,state,mergeable,mergeStateStatus,reviewDecision,headRefName,additions,deletions,changedFiles
gh pr diff <n>
```

## 3. Ticket vs code

Map each scope in the ticket to the code that satisfies it. Name anything unmatched in either direction.

## 3b. Playbook tickets: every source, every time

For any ticket under the V1 Playbook epic (QRD-1232), "AC vs code" is not a review. The code is compared against all of the sources below, and the report carries this table with one row per source. A row may say "not applicable" (with the reason) or "no source exists" (which is itself a finding), but it may not be missing.

| Source | Where | What to compare | What it decides |
|---|---|---|---|
| Ticket | Jira custom fields (User Story, Problem Definition, Acceptance Criteria), plus the parent epic and the ticket it was split from | every AC line, one row each, with `path:line` and the proving test | behaviour, storage, defaults |
| Contract | the page found by `rules/ticket-contract.md` (for Sprint 24 Playbook tickets that was page 464945153) | every section that governs the ticket, quoted verbatim with its number; field names and enum values literally; whether a frozen interface was changed; whether the ticket is in the committed set | names, shapes, interfaces, process rules. A change to a frozen section needs the amendment written on the page (its "how this page changes" section) |
| Wireframe / Figma | the Figma Link field on the ticket, the epic, the contract page, `<root>/docs` | every element of the changed screen, against screenshots of the PR running locally | every UI finding. No wireframe for the screen = say so; the AC is then the only spec |
| The other side | the BE PR when reviewing FE, and the reverse | the fields and enums one side writes against what the other reads, literally | integration |
| Sibling PRs | the same change opened against another base (develop and Playbook, or an integration train) | file lists and per-file content | whether one review covers both |
| CI | `gh pr checks`, and the failing job's log when red | local test results against CI, especially suites that cannot run locally | whether "tests pass" is true |

Rules that came from getting this wrong on 2026-10-05 (QRD-1406, QRD-1277):

- Two of three reviewers reported an Approve from the AC alone; the contract was only read when the owner asked. It turned out to hold the only literal contract mismatch of the review (a fixed interface reshaped with no amendment). Read the contract before the verdict, not after.
- When the review is delegated, every member's brief names all six sources and says which ones that member owns. A member that could not read a source says so in its report; the lead then covers it or spawns someone who can. "Not read" is never silently dropped from the summary.
- The lead re-checks the top finding from each source itself (open the diff, open the page) before repeating it to the owner.
- Frontend work is reviewed with screenshots of the PR running locally, dark mode by default, plus light mode when the AC names both. This is never optional, also when the feature cannot run end to end locally: take the real state first, then mock only the one request that needs a third party and say so per image. Screenshots go to the day's folder, `<root>/<MMDD>/qrd-<n>/` (month and day they were taken, lowercase ticket, e.g. `<root>/1006/qrd-1393/`), numbered and named for what they show. Dark mode is mandatory for every screenshot (Playwright `colorScheme: "dark"` plus localStorage `v2-theme=dark`), file name ending `-dark.png`. A `-light.png` is only ever an extra next to its dark twin, taken when the AC names light mode or the owner asks; what is shown or sent to anyone is the dark one. `<evidence>/<KEY>/` keeps only the ledger, logs, scripts, video and caches. Say exactly what was real and what was mocked.
- A contract sentence the whole team already works against (for example the PR base branch) goes to the owner as a question about the contract, not to the author as a finding.

## 4. Verify every claim

Collect every claim in the diff: code comments, commit message, variable names, magic numbers. Treat each as unverified until checked against the real file.

Pixel maths, "same as the X above", "matches the constant in Y" - open the file and confirm. This is where real findings come from.

Your own claims count too, and they are the ones that slip. Before writing "this PR introduced X" or "the old code did Y", print the before state:

```
git show origin/develop:<path> | sed -n '<range>p'
git blame -L <range> origin/develop -- <path>
```

Reasoning about what the old code "would have" done is not a baseline. Never take the baseline from a function the PR deletes: a dead function is not the live path, and a reviewer who reads it mistakes removed behaviour for current behaviour. Run blame before implying authorship - the structure you are about to hand to the author may be someone else's, already merged.

QRD-1199 is the worked example. A finding claimed the PR split an agent payload into separate blocks and separated the speaker label from the sentence. `git show origin/develop` on that one function showed the split already there; `git blame` showed it came from QRD-952 three weeks earlier, authored by the reviewer himself. The PR added one block at the front and changed nothing else. The baseline had been taken from `parseMessageForAI`, the dead function this PR deletes. One command would have killed the finding before it reached the author.

## 5. Recurring reviewer patterns

Search the vault for prior review feedback before writing findings:

```
python3 "<kitDir>/brain.py" retrieve "reviewer feedback minimal diff"
```

Known objections on this project:

- a type or parser widened beyond what the ticket needs
- an existing variable renamed or removed
- a legacy compatibility path dropped
- behaviour changed outside the ticket scope

Check the diff against each.

## 6. Stale branch check

```
git merge-base --is-ancestor <recent-develop-commit> <pr-head>
git rev-list --left-right --count origin/develop...<pr-head>
```

A branch far behind develop can be internally consistent and still break after merge. That is a real finding, phrased as "will break on merge", not "the code is wrong".

## 7. Build a comparison before concluding

Never ship a suspicion. Construct a case that isolates the variable - a control that should behave correctly next to the one that does not.

## 7b. Edge cases, impact, blast radius

A review that only confirms the diff does what it says is not finished. Every review owes at least one catch the author would not have found by re-reading their own code. If the pass produced none, the pass was too shallow - go back to the changed files and work these three angles.

Edge cases. For each changed function, name the inputs the author did not write a test for: empty, missing, duplicate, out of order, arriving twice, arriving late, exceeding a limit, failing halfway through. Then trace what the code actually does with them. A retry that arrives before the first write commits, a payload whose optional field is absent, a batch where one item throws - these are where the defects are.

Impact. For every changed behaviour, state what a user or an operator sees differently after this merge. If the answer is "nothing", say so and move on. If the answer is a silent drop, an unassigned session, a missing notice, or a duplicated row, that is a finding regardless of whether the code matches the ticket.

Blast radius. List every caller of the changed symbols and every path that reaches the changed file, not just the one the ticket is about. Shared helpers, shared types, shared middleware, shared queues, and shared enums carry the change into features nobody mentioned. Name the ones that are affected and the ones you checked and cleared - both belong in the report.

New code is not exempt. A brand-new file with no callers yet still has a blast radius through what it registers at boot: a worker, a schedule, a route, a container entry.

Prefer a verified catch over a plausible one. When a finding rests on a divergence from how the codebase already does the same job, open the existing implementation and quote it. That comparison is what makes the finding survive an argument.

## 8. Report

Order by severity: blocking, then non-blocking, then nits. A red CI is never a blocker on its own: record it as non-blocking (`CI red: <job>, <cause from its log>; re-run or fix`). Only an unmet AC or broken behaviour, quoted from the AC or contract, blocks. State what was verified and what was only reasoned about.

Each finding carries its impact and its blast radius, not just its location.

Close with Approve or Request Change.

Record the review in the ledger so the DOCK Agents page shows it: one `node <kitDir>/status.cjs finding <KEY> --severity blocker|non-blocking|nit "<finding>"` per finding, one `lgtm <KEY> "<part>"` per part that is fine, then `verdict <KEY> approve|request-change`. Approve is refused while an unresolved blocker is recorded. On a re-review, a blocker that no longer applies (the AC changed, the author fixed it) is closed with `node <kitDir>/status.cjs finding <KEY> <n> resolve "<why>"` before the new verdict; it stays in the ledger, marked resolved.

## 8b. The message to the author

Write it with the `review-message` skill (`.claude/skills/review-message/SKILL.md`): addressed to "mas", all lowercase, blocker first and blockers only when one exists, which part is lgtm by name, and each screenshot named by file inside the comment it proves.

The report above is for the user. What gets sent to the teammate is short: the verdict, then only what they must act on. Three points is the ceiling, one line each. Lowercase, no dashes as connectors.

Praise, verified-good lists, and anything the author cannot act on stay out. If a finding needs a paragraph to explain, it belongs in the report, not the message.

## 9. Queue the note

```
python3 "<kitDir>/brain.py" save --no-ingest --project "qonflo" --topic "<topic>" --title "<title>" --context "<why>" --point "<point>" --decision "<verdict>"
```

## Never

Do not draft a PR description. Push, give the compare link, stop.
