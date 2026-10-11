---
description: Antre catatan sesi ini ke raw/ Obsidian Brain (watcher yang ingest)
argument-hint: [topik atau catatan tambahan]
allowed-tools: Bash(powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/save_and_ingest.ps1:*), Bash(python3 ~/brain/scripts/brain.py save:*)
---

Antre catatan dari kerjaan sesi ini ke `raw/`. Arahan tambahan dari user: $ARGUMENTS

Langkah:

1. Rangkum sesi ini jadi metadata: `Project`, `Topic`, `Title`, `Context` (kenapa task ini muncul), 2-5 `Point` (fakta, temuan, angka, path file - bukan narasi), dan `Decision` (keputusan atau hasil akhir).
2. Jalankan dengan metadata hasil rangkuman, bukan placeholder. Pilih satu baris sesuai mesin yang sedang dipakai.

Laptop Windows:

```
powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/save_and_ingest.ps1 -NoIngest -Project "<project>" -Topic "<topic>" -Title "<judul>" -Context "<konteks>" -Point "<poin 1>","<poin 2>" -Decision "<keputusan>"
```

Workspace Linux (vault di `~/brain`):

```
python3 ~/brain/scripts/brain.py save --no-ingest --project "<project>" --topic "<topic>" --title "<judul>" --context "<konteks>" --point "<poin 1>" --point "<poin 2>" --decision "<keputusan>"
```

3. `-NoIngest` / `--no-ingest` wajib. Watcher di laptop yang menjalankan ingest, jangan panggil `ingest_raw.py`.
4. Di workspace Linux perintah itu menulis satu file baru `raw/<UTC yyyymmdd-HHMMSS>-ws-<slug>.md`, lalu `git add` file itu saja, commit, `git pull --rebase`, dan `git push` (maksimal 3 percobaan). Kalau keluarannya menyebut git gagal, laporkan pesan persisnya; file catatannya tetap ada di `raw/`.
5. Laporkan path file raw yang terbentuk, plus isi metadata yang dipakai (1 baris per field) supaya user bisa koreksi.
