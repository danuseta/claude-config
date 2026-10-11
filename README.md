# claude-config

Private repository holding the Claude Code configuration of one owner. It installs the same setup on a Windows laptop (`C:/Users/danus/.claude-kantor`) and on a Linux aarch64 cloud workspace (`/home/coder/.claude`). No secret value is stored here.

## Layout

| Path | Purpose |
|---|---|
| `manifest.json` | What is installed where, per OS; the never-tracked and import-skip lists |
| `install/install.cjs` | Installer (Node, no dependencies, Windows and Linux) |
| `install/secret-scan.cjs` | Secret scan; must exit 0 before any push |
| `install/secret-scan.allow.json` | Reviewed false positives (path, pattern, line hash) |
| `settings/` | `settings.base.json` plus `settings.windows.json` and `settings.linux.json` overlays |
| `skills/`, `agents/`, `commands/` | Copied as plain files |
| `.githooks/pre-push` | Runs the secret scan without the laptop-only literal layer |

Other folders (`kit/`, `claude/`, `linux/`, `windows/`, `plugins/`, `mcp/`, `docs/`) are owned by other parts of the project. The installer skips what is not there yet and says so.

## Install model

The repo is the source. The installer copies and renders into the Claude config directory. It never uses symlinks and never deletes anything on `--apply`.

```bash
node install/install.cjs --dry-run           # report what would change (default)
node install/install.cjs --apply             # write; settings.json is backed up first
node install/install.cjs --check             # exit 1 when something is pending
node install/install.cjs --extract-secrets   # one time: create the per-machine secret file
node install/install.cjs --uninstall --yes   # remove installed files identical to the repo
```

Options: `--os windows|linux`, `--config-dir <dir>`, `--secrets-file <file>`, `--verbose`.

## Settings templates

`settings.base.json` holds every key shared by both OSes. The overlay adds what is OS specific. Macros:

| Macro | Windows | Linux |
|---|---|---|
| `{{kit:<file> <args>}}` | `node "<configDir>/kit/<file>" <args>` | `"<configDir>/kit/bin/kit-node" <file> <args>` |
| `{{configDir}}`, `{{home}}` | config directory, home directory | same |
| `{{secret:<NAME>}}` | filled from the secret file | filled from the secret file |

The result is deep-merged into the existing `settings.json`: keys the template does not know are kept, string arrays are unioned, hook entries are keyed by (event, matcher, command) so a second run changes nothing. A `placeholder` whose secret is missing is skipped and the existing value stays.

## Secrets

| Machine | Secret file | Format |
|---|---|---|
| Laptop | `C:/Users/danus/.claude-kantor/secrets.local.json` | JSON object, name to value |
| Workspace | `/home/coder/.config/claude-config/secrets.env` | `KEY=VALUE`, mode 600 |

Placeholder names in use: `TYPESAFE_API_KEY`.

## Before the first push

```bash
git config core.hooksPath .githooks
node install/secret-scan.cjs            # last line must read: 0 findings
```

The scan has four layers: literal values read from the laptop's own secret files (laptop only), token patterns, forbidden file names and sizes, and `gitleaks` when it is installed. A match is reported as `path:line` plus a pattern or key name, never the value. A reviewed documentation example goes into `install/secret-scan.allow.json`.
