# Arsitektur claude-config

Repo ini adalah sumber konfigurasi Claude Code milik satu orang. Satu repo dipasang ke dua mesin. Tidak ada secret di dalamnya.

## Dua mesin

| | Laptop | Workspace Coder |
|---|---|---|
| OS | Windows 11 | Linux aarch64 |
| Folder konfigurasi | `C:/Users/danus/.claude-kantor` | `/home/coder/.claude` |
| Checkout repo | `C:/Users/danus/claude-config` | `/home/coder/claude-config` |
| Secret | `secrets.local.json` di folder konfigurasi | `~/.config/claude-config/secrets.env` (mode 600) |
| Shell | Git Bash | bash |

## Cara pasang

Installer menyalin dan merender. Tidak ada symlink, dan `--apply` tidak menghapus apa pun.

1. `node install/install.cjs --dry-run` menampilkan apa yang akan berubah.
2. `node install/install.cjs --apply` menulis. `settings.json` dicadangkan dulu.
3. `node install/secret-scan.cjs` harus lulus sebelum push.

## Dari mana tiap file berasal

| Hasil di folder konfigurasi | Dirangkai dari |
|---|---|
| `CLAUDE.md` (Windows) | `claude/CLAUDE.common.md` lalu `claude/CLAUDE.windows.md` |
| `CLAUDE.md` (Linux) | `claude/CLAUDE.common.md` lalu `claude/CLAUDE.linux.md` |
| `AGENTS.md`, `RTK.md`, `DESIGN_THINKING.md`, `karpathy-principles.md` | Disalin apa adanya dari `claude/`, sama di dua OS |
| `settings.json` | `settings/settings.base.json` ditambah overlay per OS |
| Plugin | `plugins/plugins.json` |
| MCP | `mcp/mcp.windows.json` atau `mcp/mcp.linux.json` |

## Cara `CLAUDE.md` dipecah

Pemecahan hanya memindahkan baris. Tidak ada kata yang diubah.

| Bagian | Tempat | Alasan |
|---|---|---|
| "Delegation rules: agy-bridge" | `CLAUDE.windows.md` | Antigravity CLI hanya ada di laptop |
| "Shell" (Git Bash, PowerShell) | `CLAUDE.windows.md` | Khusus Windows |
| "RTK dulu, tool native belakangan", "Berlaku juga di subagent dan worker", `@RTK.md` | `CLAUDE.common.md` | Aturan rtk sama di dua mesin |
| Shell bash, peta workspace, batas test, larangan giliran chat tanpa pengawasan | `CLAUDE.linux.md` | Baru; sumbernya rencana bagian 1.3, F, P.2, P.5 |

Installer menaruh bagian umum di depan, jadi urutan `CLAUDE.md` Windows berubah: bagian rtk sekarang di atas, aturan delegasi dan Shell di bawah. Isinya tetap.

`AGENTS.md` pribadi masih menyebut skrip Brain `.ps1` dan path `E:\`. File itu disalin sama di dua OS, jadi padanan Linux (`python3 ~/.claude/kit/brain.py`) ditulis di `CLAUDE.linux.md`.

## Klien Brain di kit

`kit/brain.py` adalah salinan byte-identik `scripts/brain.py` dari repo `danuseta/brain`. Workspace tidak punya vault, jadi klien dikirim lewat kit. Hook retrieval (`UserPromptSubmit`) dan autosave (`Stop`) di `settings.base.json` memanggil salinan ini di dua OS; macro `{{python}}` menjadi `python` di Windows dan `python3` di Linux. Mode diatur overlay: Windows `BRAIN_MODE=local` dengan `BRAIN_MACHINE=laptop` dan `BRAIN_ROOT=E:/obsidian/Brain`, Linux `BRAIN_MODE=remote`.

Tiap mesin meng-ingest areanya sendiri. Laptop menyimpan ke `raw/laptop/`, watcher `watch_raw.ps1` meng-ingest ke `wiki/laptop/`, `index-laptop.md`, `log-laptop.md`, lalu commit area itu, `pull --rebase`, dan push. Workspace tidak punya vault: catatannya dikirim ke server Brain di VPS, yang meng-ingest ke `wiki/workspace/` dan mendorongnya lewat sync git server. `wiki/sources|concepts|entities`, `index.md` dan `log.md` lama hanya dibaca. Retrieve, search dan read membaca legacy plus semua area mesin. Laptop jangan memakai `hybrid`: di mode itu catatan laptop dikirim ke server dan ikut masuk area `workspace`.

`kit/tests/brain-copy.test.cjs` gagal kalau salinan bergeser dari hash yang dicatat, atau dari `E:/obsidian/Brain/scripts/brain.py` kalau vault ada di mesin itu. Cara memperbarui setelah `brain.py` berubah di repo vault:

1. `git -C E:/obsidian/Brain fetch origin`
2. `git -C E:/obsidian/Brain show origin/main:scripts/brain.py > kit/brain.py`
3. `sha256sum kit/brain.py`, lalu salin hasilnya ke `RECORDED_SHA256` dan hash commit sumber ke `SOURCE_COMMIT` di `kit/tests/brain-copy.test.cjs`.
4. `node --test kit/tests`, lalu `ccfg update` di workspace dan `install.cjs --apply` di laptop.

## Cek isi

`node docs/check-content-split.cjs` membandingkan lima file sumber di laptop dengan hasil pecahan. Hasil yang diharapkan: tidak ada baris hilang, ganda, atau asing di file umum dan Windows.
