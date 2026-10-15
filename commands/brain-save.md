---
description: Antre catatan sesi ini ke Obsidian Brain (tiap mesin meng-ingest areanya sendiri)
argument-hint: [topik atau catatan tambahan]
allowed-tools: Bash(powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/save_and_ingest.ps1:*), Bash(python3 ~/.claude/kit/brain.py save:*)
---

Antre catatan dari kerjaan sesi ini ke Brain. Arahan tambahan dari user: $ARGUMENTS

Langkah:

1. Rangkum sesi ini jadi metadata: `Project`, `Topic`, `Title`, `Context` (kenapa task ini muncul), 2-5 `Point` (fakta, temuan, angka, path file - bukan narasi), dan `Decision` (keputusan atau hasil akhir).
2. Jalankan dengan metadata hasil rangkuman, bukan placeholder. Pilih satu baris sesuai mesin yang sedang dipakai.

Laptop Windows:

```
powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/save_and_ingest.ps1 -NoIngest -Project "<project>" -Topic "<topic>" -Title "<judul>" -Context "<konteks>" -Point "<poin 1>","<poin 2>" -Decision "<keputusan>"
```

Workspace Linux (tanpa vault, `BRAIN_MODE=remote`):

```
python3 ~/.claude/kit/brain.py save --no-ingest --project "<project>" --topic "<topic>" --title "<judul>" --context "<konteks>" --point "<poin 1>" --point "<poin 2>" --decision "<keputusan>"
```

3. Jangan panggil `ingest_raw.py`. Di laptop, catatan masuk `raw/laptop/` dan watcher yang meng-ingest ke `wiki/laptop/`. Di workspace, server Brain yang meng-ingest ke `wiki/workspace/`.
4. Hasilnya satu baris: `Saved raw note: <path>` (tersimpan di vault laptop atau terkirim ke server) atau `Spooled (offline): <id>` (server tidak terjangkau; catatan dikirim ulang otomatis lewat hook atau `brain.py flush`). Kode keluar 1 berarti server menolak catatan atau spool penuh; laporkan pesannya persis.
5. Laporkan baris hasil itu, plus isi metadata yang dipakai (1 baris per field) supaya user bisa koreksi.
