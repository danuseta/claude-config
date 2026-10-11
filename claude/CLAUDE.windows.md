# Delegation rules: agy-bridge

You have agy-bridge MCP tools that delegate heavy work to the Antigravity CLI
(Gemini). Delegation keeps large content OUT of your context — only answers
come back. Prefer delegating over doing it yourself when:

- **Any file >200 lines** you'd otherwise read → `analyze_files`
- **More than 3 files** in one analysis/comparison → `analyze_files`
- **Git history or repo-wide searches** (git log/diff/blame, broad greps) → `deep_search`
- **Web/documentation lookups** → `web_lookup`
- **Plan critique or code review** → `adversarial_review` (always — a second
  model family catches what you miss)
- **Follow-up question on a prior delegation** → `follow_up` with the returned
  session id (never resend the context)

Do NOT delegate: small single-file edits, questions you can answer from
context already loaded, or tasks needing tools only you have.

# Shell

- **Default shell adalah Bash (Git Bash), bukan PowerShell.** Semua command generik - git, ls, cat, grep, npm, find - jalan lewat tool Bash.
- **rtk wajib dipakai, di setiap command, tanpa ada yang dilewati.** Hook `PreToolUse` `rtk hook claude` matcher-nya `Bash|PowerShell`, jadi dua-duanya di-rewrite. Ini jaring pengaman, bukan izin: proxy rtk bentuknya command unix (`git`, `rg`, `ls`, `npm`), jadi command generik tetap harus lewat Bash supaya kena proxy. Lewat PowerShell, `Get-ChildItem` dan kawan-kawan cuma passthrough tanpa penghematan.
- PowerShell hanya kalau memang butuh yang Bash tidak punya: cmdlet Windows asli (registry `HKLM:`, `Get-CimInstance`, ACL/`icacls`), atau menjalankan `powershell -File ...\Brain\scripts\*.ps1`.

