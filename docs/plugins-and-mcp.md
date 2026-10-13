# Plugin dan server MCP

## Plugin

Daftar lengkap ada di `plugins/plugins.json`. Empat plugin, versi sama di dua OS.

| Plugin | Marketplace | Versi | Catatan |
|---|---|---|---|
| typesafe | typesafe-ai | 0.5.7 | Butuh `TYPESAFE_API_KEY` |
| caveman | caveman | 3.2.0 | Mati di sesi headless tanpa `CAVEMAN_DEFAULT_MODE`; bridge yang menyetelnya |
| oh-my-claudecode | omc | 5.7.1 | Marketplace lewat URL git |
| superpowers | superpowers-marketplace | 7.0.0 | - |

Perintahnya: `claude plugin marketplace add <sumber>`, lalu `claude plugin install <nama>@<marketplace>`.

## Server MCP per OS

Nilai kunci selalu berbentuk `{{secret:NAMA}}`. Tidak ada nilai asli di file.

| Server | Laptop | Workspace | Kunci | Catatan |
|---|---|---|---|---|
| filesystem | ya | tidak | - | Memakai path Windows |
| git (uvx) | ya | ya | - | - |
| github | ya | ya | `GITHUB_PERSONAL_ACCESS_TOKEN` | Di workspace diisi dari `gh auth token` |
| sequential-thinking | ya | ya | - | - |
| playwright `--extension` | ya | tidak | - | Butuh ekstensi Chrome laptop; workspace punya `playwright-cli` |
| context7 | ya | ya | - | - |
| exa | ya | ya | `EXA_API_KEY` | Opsional di workspace |
| figma | ya | ya | OAuth | Login ulang dari workspace (lihat `workspace-runbook.md`) |
| firecrawl | ya | ya | `FIRECRAWL_API_KEY` | Opsional di workspace |
| serena (uvx) | ya | ya | - | - |
| atlassian | ya | ya | OAuth | Login ulang dari workspace |

Yang tidak dibawa sama sekali: `agy-bridge` (Antigravity hanya di laptop) dan konektor claude.ai (tidak ikut token kantor). Server `mongodb` di workspace datang dari template Coder dan tidak diurus repo ini.
