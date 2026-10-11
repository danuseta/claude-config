---
description: Cek proses watcher Obsidian Brain dan nyalakan kalau mati
allowed-tools: Bash(python3 ~/brain/scripts/brain.py:*), Bash(E:/obsidian/Brain/scripts/watcher-status.cmd), Bash(powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/start-watcher-detached.ps1), PowerShell(Get-CimInstance*)
---

Status antrean dan log:

!`python3 ~/brain/scripts/brain.py status 2>/dev/null || E:/obsidian/Brain/scripts/watcher-status.cmd`

Langkah:

0. Workspace Linux: watcher tidak ada di sini (ingest hanya jalan di laptop). Jalankan `python3 ~/brain/scripts/brain.py watch` untuk pesannya, laporkan, lalu berhenti. Langkah 1-4 hanya untuk laptop Windows.
1. Cek prosesnya benar-benar hidup:

```
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*watch_raw.ps1*' } | Select-Object ProcessId, CreationDate
```

2. Kalau tidak ada prosesnya, nyalakan detached:

```
powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/start-watcher-detached.ps1
```

3. Kalau sudah ada satu proses, jangan start lagi (dobel watcher = dobel ingest). Laporkan PID dan sejak kapan jalan.
4. Setelah start, konfirmasi lewat baris `Watcher started` terbaru di `E:\obsidian\Brain\logs\watch_raw.out.log`.
