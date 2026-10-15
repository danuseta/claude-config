---
description: Cek atau nyalakan watcher Obsidian Brain di laptop
allowed-tools: Bash(python3 ~/.claude/kit/brain.py:*), Bash(E:/obsidian/Brain/scripts/watcher-status.cmd), Bash(powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/start-watcher-detached.ps1)
---

!`python3 ~/.claude/kit/brain.py watch 2>/dev/null || E:/obsidian/Brain/scripts/watcher-status.cmd`

Langkah:

0. Laptop: watcher `watch_raw.ps1` meng-ingest `raw/laptop/` ke area `laptop` lalu commit dan push area itu saja. Kalau keluaran di atas bilang watcher tidak jalan, nyalakan dengan `powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/start-watcher-detached.ps1`.
1. Workspace: tidak ada watcher. Server Brain yang meng-ingest area `workspace`.
2. Laporkan keluaran di atas apa adanya, lalu arahkan user ke `/brain-status` untuk antrean, status ingest, dan spool.
