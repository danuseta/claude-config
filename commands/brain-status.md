---
description: Status Brain di mesin ini: antrean ingest, sinkron git, dan spool
allowed-tools: Bash(python3 ~/.claude/kit/brain.py status:*), Bash(E:/obsidian/Brain/scripts/watcher-status.cmd), Read
---

!`python3 ~/.claude/kit/brain.py status 2>/dev/null || E:/obsidian/Brain/scripts/watcher-status.cmd`

Ringkas dalam 3-5 baris:

- Antrean: berapa catatan raw menunggu ingest. Laptop: `raw/laptop/` (watcher). Workspace: antrean server Brain.
- Status ingest: sedang jalan atau tidak, dan kapan ingest terakhir selesai.
- Sinkron git: commit dan push terakhir vault; di laptop juga umur pull terakhir.
- Spool: berapa catatan di mesin ini yang belum terkirim. Kalau > 0, sarankan `brain.py flush` setelah server terjangkau.
- Kalau perintah di atas gagal menjangkau server, laporkan pesannya persis.
