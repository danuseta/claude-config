# DOCK on your Coder workspace

DOCK runs inside your own workspace. One command sets it up.

## Install

Run in the workspace terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/danuseta/claude-config/stable/linux/bootstrap.sh | bash
```

This command works once the `stable` branch exists; the owner creates it after merge.

The script clones `claude-config` to `~/claude-config`, installs `~/personalize`, and runs it.

## What it sets up

- DOCK server on `127.0.0.1:4100`, kept alive by a supervisor.
- Chat bridge, started after DOCK.
- Ingest token and URL (`http://127.0.0.1:4100/ingest/orchestrator`) in `secrets.env`, created once.
- Rerun safe: no second server, no second bridge, no new token, DOCK data kept.
- Exit code is non-zero when the DOCK or bridge step failed.

## Open DOCK

1. Open the Coder dashboard for your workspace.
2. Click the **DOCK** button. Only the workspace owner sees it work.

## First run

DOCK shows a **Set PIN** screen. Nothing else opens until the PIN is saved.

## Settings

All values are stored encrypted.

| Setting | Where |
|---|---|
| Jira URL, email, API token, project keys | Settings, Jira |
| GitHub token | Settings, GitHub |
| Discord bot token and guild | Settings, Discord |

After saving Jira, the board and `uat-check` show your own tickets. The Home greeting uses your own name.

## Updates

- Workspaces follow the `stable` branch.
- Owner override: a local env file, default `~/.config/claude-config/versions.local.env` (path set by `CCFG_VERSIONS_FILE`), containing
  `CCFG_BRANCH=main`, `DOCK_BRANCH=main`, `ENABLE_TAILSCALE=1`, one per line as plain `KEY=value` without `export`.
- A failed build keeps the previous DOCK and bridge running.

## Tailscale

Off by default. Nothing installs `tailscaled` and nothing uses the `127.0.0.1:1055` proxy. Set `ENABLE_TAILSCALE=1` to opt in. `ccfg doctor` reports Tailscale as SKIP when off.

## Troubleshooting

1. Run `ccfg doctor`. Read the first FAIL line.
2. Check health: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4100/health` should print `200`.
3. Run `~/personalize` again. It is safe to repeat.
4. Check `ccfg status` for server, bridge, and the last run result.
5. DOCK button unhealthy in Coder: DOCK is down. Do step 3.
