# qonflo-qa-local

Runs a ticket's acceptance tests against a local Qonflo stack in this workspace, with the rules of the QA v2 agent, and predicts its verdict: LOLOS, REVISION, AC-GAP or ESCALATED.

It never touches UAT, never writes to Jira, Confluence or Drive, and never writes into `~/qa`. The code lives in the kit (`~/.claude/kit/qa-local`); the data stays in `~/qa-local` (`QA_LOCAL_DIR` overrides it). It logs in only as `local@test.com` and `local2@test.com`.

## Two steps

The command cannot reach Jira. Testing a ticket is therefore two steps:

1. **Agent step.** An agent follows the QA v2 flow (triage, Perencana, Peninjau, Pelaksana) against the local stack and writes `~/qa-local/tests/<KEY>/`.
2. **Command.** `qonflo-qa-local <KEY>` boots the stack, runs the specs, records videos and writes the run folder.

The command stops with exit 2 and explains what to create when `ac.json` or the specs are missing.

## Agent step (v2)

Use this as the prompt for the agent that prepares a ticket. The rules are the QA v2 skill's, installed by `qa-skill-sync.sh` in `~/.claude/skills/skill-qonflo-qa/` (check `VERSION`; if the folder is missing, run `bash ~/.claude/kit/qa-skill-sync.sh` first). Read the file named in each step before doing it; this README only fixes names, paths and what changes locally.

Paths used below (`S` is the skill folder):

| Name | Path |
|---|---|
| `S` | `~/.claude/skills/skill-qonflo-qa` (rules `S/triage-rules.md`, `S/planner.md`, `S/reviewer.md`, `S/executor.md`, `S/plan-schema.md`, `S/judge.md`; scripts in `S/scripts`) |
| `T` | `~/qa-local/tests/<KEY>` (the runner reads `ac.json`, `TC.md` and the specs from here) |
| `P` | `~/qa-local/tests/<KEY>/plan` (holds `plan.json`, `ticket.md`, `elements.md`, `review-r<N>.json`, `review.json`; the runner skips it) |
| `M` | `~/qa-local/feature-map` (the feature maps; see step 3) |

Every `node` call below runs with `QA_MAP_DIR=~/qa-local/feature-map` so the scripts read and write maps there, never in `~/qa`.

> Prepare `~/qa-local/tests/<KEY>/` for `qonflo-qa-local`, following the QA v2 flow against this workspace's local stack. Write nothing outside `~/qa-local`.
>
> 1. **Ticket.** Get the Atlassian `cloudId` from `getAccessibleAtlassianResources`. Fetch `<KEY>` with `getJiraIssue` (`view: "evidence"`, fields `summary`, `description`, `issuelinks`, `customfield_10332`). This read is the only Jira call allowed. Number the AC lines as `triage-rules.md` "Mencari AC" says (AC-1, AC-2, ... top to bottom across groups), exactly as written. Save the raw ticket text (title, description, AC as written) to `P/ticket.md`.
> 2. **Triage** per `S/triage-rules.md`: decide `UJI`, `ESKALASI`, `LEWATI` or `FOLLOW`. Do not decide `DATA_PRASYARAT` here (the rules say so). Write `T/triage.json` with the entry shape of "Kode alasan" and "LEWATI"/"FOLLOW" (`ticket`, `decision`, `reason`, `reasonCode`, `acs`). Anything but `UJI` stops the run: write no plan and no spec, and record the stop with `qonflo-qa-local <KEY> --triage-stop <reasonCode> "<reason>"` (no stack, no Playwright; it writes a run folder with verdict ESCALATED that DOCK shows). `LEWATI` is `BE_ONLY`, `FOLLOW` and a pair FE ticket without a result are `FE_LINKED`, the rest use the code the rules name. When the BE ticket has a paired FE ticket (`FOLLOW`, or `FE_LINKED` with the FE key known), add `--fe <FE-KEY> --fe-status "<FE status>"`: the run folder then holds `followsFe` and verdict `FOLLOWS_FE`, and DOCK shows it as following that FE ticket, not as escalated; end with `FOLLOWS_FE <FE-KEY>: <reason>`. Otherwise end with one line `ESCALATED <reasonCode>: <reason>`. No label, no comment, no transition, no `triage-skip.mjs`, `triage-follow.mjs` or `triage-rfp.mjs`.
> 3. **Perencana** per `S/planner.md`, steps 1 to 9, with the format of `S/plan-schema.md` (example: `S/plan-example.json`). Scan the local frontend (the stack is not running yet: start it with `~/.claude/kit/stack.sh up` for the ticket's worktrees, and stop it when the plan is done), write `P/elements.md`, and use `M/<object>.md` for the feature maps (bootstrap a draft map there when `planner.md` step 4 says so; copy a map from `~/qa/feature-map/` first when it exists). Write `P/plan.json`, then run:
>    ```
>    node ~/.claude/skills/skill-qonflo-qa/scripts/plan-filter.mjs filter P/plan.json --out P/plan.json
>    node ~/.claude/skills/skill-qonflo-qa/scripts/plan-check.mjs P/plan.json
>    ```
>    (and `plan-filter.mjs pairwise <params.json>` only when `planner.md` step 6 applies). Fix every `errors` entry until `plan-check` exits 0.
> 4. **Peninjau** per `S/reviewer.md`, at most 2 rounds:
>    ```
>    node ~/.claude/skills/skill-qonflo-qa/scripts/run-reviewer.mjs <KEY> --round 1 --plan P/plan.json
>    ```
>    Verdict `Revisi`: fix every revisi finding in all TCs it names, rerun `plan-check`, then `--round 2`. A `Revisi` in round 2, `eskalasi: true`, or exit 3 or 4 stops the run exactly like step 2: write `T/triage.json` with `decision: "ESKALASI"`, `reasonCode: "LAINNYA"` and the reviewer's reason, run `qonflo-qa-local <KEY> --triage-stop LAINNYA "<reason>"`, and end with `ESCALATED LAINNYA: <reason>`. Do not start a round 3 locally. `OK` or `lanjut_dengan_catatan` goes on.
> 5. **Specs** per `S/executor.md` sections 1 and 2: one spec per TC of `plan.json`, in `T/*.spec.ts`. The title starts with the plan's TC id and a colon (`<KEY>-TC001: ...`). Import from `@playwright/test`. Use relative URLs (`page.goto("/contacts")`): `baseURL` is the local frontend. Wrap every action in `aksi("...", ...)` and every observation in `lihat("...", ...)` from `./steps` (copy `~/qa/fixtures/steps.ts` to `T/steps.ts` when `~/qa` exists, else create it from the block below). The default login is `local@test.com`; a TC for the second user runs inside `test.describe` with `test.use({ storageState: process.env.QA_STATE_LOCAL2 })`. The backend URL is in `process.env.QA_BE_URL`. A workflow page may ask for the access PIN `767676`. A "Maybe Later" dialog may cover the page; close it when it appears. Each test builds its own `qa-` data through the UI (`prasyarat` of the TC), asserts the *Then* part with `expect`, and removes its data at the end (`plan.pembersihan`).
> 6. **`T/ac.json`**, for the runner (the runner never reads `plan.json`):
>    ```json
>    {
>      "key": "<KEY>",
>      "summary": "<summary>",
>      "fetchedAt": "<ISO time of the fetch>",
>      "source": "jira customfield_10332",
>      "ac": [{ "n": 1, "text": "<AC-1 as written>" }],
>      "tcs": [{ "id": "<KEY>-TC001", "title": "<scenario of the TC>", "ac": [1], "user": "local" }]
>    }
>    ```
>    `n` is the number of the plan's `AC-n`. `id` is the plan's `tc` id, the same text the spec title starts with. Every AC line needs at least one TC. `user` is `local` or `local2`.
> 7. **`T/TC.md`**: the TC table in the format of `S/testcase-template.md`, from `plan.json`.
> 8. **Run** `qonflo-qa-local <KEY>` (add `--be` and `--fe` when the ticket has worktrees). When it ends, make the per-TC process log and check it:
>    ```
>    node ~/.claude/skills/skill-qonflo-qa/scripts/step-log.mjs <KEY> --results <run folder>/pw-report.json --out <run folder>/steps
>    node ~/.claude/skills/skill-qonflo-qa/scripts/step-log.mjs <KEY> --results <run folder>/pw-report.json --out <run folder>/steps --check
>    ```
>    Exit 2 from `--check` means a TC has no `lihat` step or a failed one on a passed test: fix the spec (never the log) and run `qonflo-qa-local <KEY>` again. A spec that was wrong, not the application, is the only reason for a second run, once per TC (`executor.md` section 2, rule 3). Report the verdict line of the last run.

Forbidden locally, whatever the skill files say:

- `upload-batch.mjs`, `upload-evidence.mjs`, `notulen.mjs` upload, `S/claim-and-label.md`, `S/transition.md`, `jira-label.mjs`, `plan-transition.mjs`, `triage-skip.mjs`, `triage-follow.mjs`, `triage-rfp.mjs`, the supervisor scripts and `qonflo-qa-*` commands of `~/qa`.
- Any Jira write (label, comment, transition, edit, create) and every Confluence or Drive call. The only allowed Atlassian call is the read-only `getAccessibleAtlassianResources` plus `getJiraIssue` of step 1.
- UAT: no URL other than `localhost`, no UAT login, no UAT account.
- Writing into `~/qa`. It is read-only here (`fixtures/steps.ts` and the feature maps are copied out of it).

`steps.ts`, when `~/qa/fixtures/steps.ts` does not exist:

```ts
import { test } from "@playwright/test";

export function aksi<T>(title: string, fn: () => Promise<T> | T): Promise<T> {
	return test.step(`[AKSI] ${title}`, fn);
}

export function lihat<T>(title: string, fn: () => Promise<T> | T): Promise<T> {
	return test.step(`[HASIL] ${title}`, fn);
}
```

A step title names the element, never a typed password, PIN, token or cookie.

Example spec:

```ts
import { test, expect } from "@playwright/test";
import { aksi, lihat } from "./steps";

test("QRD-1234-TC001: owner sees the Tags column", async ({ page }) => {
	await aksi("QA opens the Contacts page", () => page.goto("/contacts"));
	await lihat("The Tags column header is visible", () => expect(page.getByRole("columnheader", { name: "Tags" })).toBeVisible());
});

test.describe("as local2", () => {
	test.use({ storageState: process.env.QA_STATE_LOCAL2 });
	test("QRD-1234-TC002: a member cannot delete a tag", async ({ page }) => {
		await aksi("QA opens the Contacts page", () => page.goto("/contacts"));
		await lihat("No Delete tag button is shown", () => expect(page.getByRole("button", { name: "Delete tag" })).toHaveCount(0));
	});
});
```

## Command

```
qonflo-qa-local <KEY> [--be <worktree> --fe <worktree>] [--keep-stack]
qonflo-qa-local <KEY> --no-stack --be-url http://localhost:<port> --fe-url http://localhost:<port>
qonflo-qa-local <KEY> --triage-stop <CODE> "<reason>" [--fe <FE-KEY> [--fe-status "<status>"]]
qonflo-qa-local --stop <run folder>
qonflo-qa-local --help
```

`--triage-stop` records a run that ended at triage or review: `<CODE>` is a v2 reason code (`BE_ONLY`, `MCP_LUAR`, `DEPENDENSI`, `DATA_PRASYARAT`, `PIHAK_KETIGA`, `AKUN_KEDUA`, `FE_LINKED`, `PARSIAL`, `LAINNYA`). It starts no stack and no Playwright, takes the one-run lock, and writes `runs/<KEY>/<UTC>/` with `progress.json` (state `done`, steps skipped, `tcs` empty, verdict `ESCALATED`, rule `J-ESCALATED`), `summary.md` and `results.json` (`stoppedAt`, `reasonCode`, `reason`). Exit 3.

With `FE_LINKED`, `--fe <FE-KEY>` names the FE ticket a BE ticket follows (`--fe` is a ticket key here, not a worktree) and `--fe-status` its Jira status: `results.json` and `progress.json` get `followsFe: { key, status }`, the verdict is `FOLLOWS_FE` with rule `J-FOLLOWS-FE` instead of `ESCALATED`, and the exit code stays 3 because nothing was tested.

What it does:

1. Checks the inputs (`ac.json`, specs), the Playwright runner (`~/qa/node_modules/@playwright/test`, else `~/.claude/kit/qa-local/node_modules/@playwright/test`), and the password file (`QONFLO_PASS_FILE` or `~/.qonflo-pass`; `QONFLO_PASS_FILE_2` for `local2`, else the same file). It only checks that the file exists; it never reads it.
2. Picks the worktrees: the flags; otherwise `~/projects/wt-<number>*-be` and `-fe` when exactly one folder matches each; otherwise the main clones as they are, without switching branches. When several worktrees match, it warns and uses the main clone, so pass `--be` and `--fe`.
3. Refuses to start a backend whose `.env` points MongoDB or Redis away from this machine.
4. Picks the first free backend port from 3200 and frontend port from 5300, skipping the protected ports 3000, 3001, 5173, 5174, 5000, 3100, 13337, 13339, 8099, 27017, 6379, 1055.
5. Starts the backend (`tsx --require ~/.claude/kit/ai-preload.cjs src/core/app.ts`, `PORT=<be>`) and the frontend (`vite --config ~/.claude/kit/vite.wt.config.mjs --port <fe> --strictPort`, `VITE_QONFLO_API_URL=http://localhost:<be>`), the same commands as `~/.claude/kit/stack.sh up`. Each runs detached in its own process group with its log in the run folder.
6. Waits until both answer over HTTP, then logs in both users through `~/.claude/kit/login-state.cjs <fe-port> <email>` and copies each storage state into the run folder.
7. Runs Playwright with one worker and video on for every test.
8. Stops exactly the process groups it started, also on Ctrl+C, SIGTERM or a crash, unless `--keep-stack` is given. It deletes the copied login states.
9. Writes the run folder and prints the verdict prediction.

One run at a time: a second run while one is active stops with exit 5.

## Run folder

`~/qa-local/runs/<KEY>/<UTC timestamp>/`:

| Path | Content |
|---|---|
| `summary.md` | Verdict prediction with its rule, stack, TC table, AC coverage |
| `results.json` | The same data, machine-readable |
| `videos/<TC-id>.webm` | One video per TC |
| `logs/` | `be.log`, `fe.log`, `login-local.log`, `login-local2.log`, `playwright.log` |
| `pw-report.json`, `pw-output/` | Playwright's own report, traces and failure screenshots |
| `stack.json` | The processes this run started |

## Verdict prediction

The ticket verdict is computed by the QA v2 skill's own `scripts/compute-verdict.mjs`, resolved only from `QA_COMPUTE_VERDICT` or `~/.claude/skills/skill-qonflo-qa` (installed by `qa-skill-sync.sh`), so the priority (REVISION, then AC-GAP, then ESCALATED, then LOLOS) lives in one place. `lib/judge.cjs` only maps each Playwright outcome to a TC status and hands the rows to that script:

- passed is `Passed`;
- an assertion failure is `Failed` with finding `REVISION` and severity `Mayor` proposed (a human decides; the tool runs each TC once, so the 2-of-2 confirmation in judge.md is not done);
- every other outcome (environment, timeout, skipped or manual TC, missing test) is `Blocked`;
- a run that never reached the tests, a test without a TC id, and an AC line without a TC each add a `Blocked` row.

Each run names the rule it ended on (`J-REVISION`, `J-AC-GAP`, `J-ESCALATED`, `J-LOLOS`). `results.json` carries `tickets[]` in the ~/qa shape and `verdictIn[]` in the `compute-verdict.mjs` input shape. See the repo's `CLAUDE.md` for which rules live in one place and which in two.

## Progress file

While a run is going, `<run folder>/progress.json` holds the live state. DOCK's "Run QA" panel reads it.
Its `schema` field names the format, now `qonflo-qa-local-progress/1`: `state` (`running`, `done`, `failed`),
`step` and `steps[]` (`stack`, `login`, `tests`, `judge`), `tcs[]` (`id`, `title`, `ac`, `state`, `seconds`, `video`, `note`),
then `verdict`, `rule`, `counts` and `error` once it ends. A change that renames or removes a field raises the number
after the slash, so a reader that only knows `/1` can say so instead of showing an empty panel. Adding a field keeps it.

## Version

`~/.claude/skills/skill-qonflo-qa/VERSION` (`<tag> <commit>`) names the QA v2 release the rules and the verdict script come from, so a result can be traced to it.

## Install

The kit ships this folder. `ccfg update` and the workspace updater run `personalize.sh --only=qa`, which runs `qa-local/install.sh`
(links `~/.local/bin/qonflo-qa-local` to `~/.claude/kit/qa-local/bin/qonflo-qa-local`, and installs `@playwright/test` from `package.json`
in `~/.claude/kit/qa-local` when neither `~/qa` nor that folder has one) and `qa-skill-sync.sh` (the QA v2 skill). The data in
`~/qa-local` (`tests/`, `runs/`) is not touched. An older install in `~/qa-local/bin` and `~/qa-local/lib` is left alone and no longer used.
