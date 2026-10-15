---
description: Watcher Obsidian Brain sudah tidak dipakai; arahkan ke status server Brain
allowed-tools: Bash(python3 ~/.claude/kit/brain.py:*), Bash(E:/obsidian/Brain/scripts/watcher-status.cmd)
---

!`python3 ~/.claude/kit/brain.py watch 2>/dev/null || E:/obsidian/Brain/scripts/watcher-status.cmd`

Langkah:

0. Laptop dan workspace: tidak ada watcher. Ingest dijalankan server Brain. Jangan menyalakan `watch_raw.ps1` atau `start-watcher-detached.ps1`: watcher di laptop berarti penulis kedua ke vault.
1. Laporkan keluaran di atas apa adanya, lalu arahkan user ke `/brain-status` untuk antrean server, status ingest, dan spool.
