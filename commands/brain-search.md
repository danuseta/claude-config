---
description: Retrieval keyword dari vault Obsidian Brain
argument-hint: <keyword task>
allowed-tools: Bash(python3 ~/brain/scripts/brain.py:*), Bash(powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/brain-retrieve.ps1:*), Bash(powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/brain-search.ps1:*), Read
---

Hasil retrieval berperingkat untuk keyword: **$ARGUMENTS**

!`python3 ~/brain/scripts/brain.py retrieve --max-files 10 -- "$ARGUMENTS" 2>/dev/null || powershell -NoProfile -ExecutionPolicy Bypass -File E:/obsidian/Brain/scripts/brain-retrieve.ps1 "$ARGUMENTS" -MaxFiles 10`

Yang perlu dilakukan:

1. Kalau hasil di atas kosong atau error, bilang terus terang dan usulkan keyword lain. Jangan mengarang isi vault. Untuk grep mentah tanpa ranking, ada `brain.py search "<keyword>"` (workspace Linux: `python3 ~/brain/scripts/brain.py search`) atau `brain-search.ps1` (laptop Windows) dengan argumen yang sama.
2. Baca 1-3 note paling relevan pakai Read (path relatif ke root vault: `E:\obsidian\Brain` di laptop, `~/brain` di workspace).
3. Ringkas temuannya dalam beberapa poin, pakai `[[wikilink]]` untuk merujuk note.
4. Sebut kalau ada gap: topik yang dicari belum ada catatannya di vault.
