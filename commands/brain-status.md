---
description: Status watcher Obsidian Brain, antrean raw, dan log ingest terakhir
allowed-tools: Bash(python3 ~/brain/scripts/brain.py status:*), Bash(E:/obsidian/Brain/scripts/watcher-status.cmd), Read
---

!`python3 ~/brain/scripts/brain.py status 2>/dev/null || E:/obsidian/Brain/scripts/watcher-status.cmd`

Ringkas dalam 3-5 baris:

- Laptop Windows: watcher hidup atau tidak (baris `Watcher started` terakhir vs sekarang; `Task state` cuma status Task Scheduler, bukan status prosesnya).
- Berapa note masih nyangkut di antrean `raw/` (`Queued raw notes`). Kalau > 0 dan tidak ada aktivitas ingest baru di log, curigai watcher mati (laptop). Di workspace Linux antrean itu normal: catatan menunggu laptop menariknya dan meng-ingest.
- Workspace Linux: tidak ada watcher; baris `Mode: workspace`, `Last commit`, dan `Last pull` menunjukkan seberapa basi vault lokal.
- Kalau ada indikasi watcher di laptop mati, sarankan `/brain-watcher`.
