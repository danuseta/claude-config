# Prompt S<n> - <KEY> "<judul tiket>"

Kamu adalah **S<n>**. Tiket **<KEY>**, repo `<be|fe>`, worktree `<root>/wt-<n>-<be|fe>`, branch `feat/<KEY>-<slug>`.
Batas berkas ini 4 KB. Status, keputusan dan isu ada di ledger; `NOW.md` di folder ini di-generate darinya.

## Baca dulu

1. `NOW.md`: seluruhnya (keputusan yang berlaku, isu terbuka)
2. `materials/02-contract.md` §<n>: <kenapa bagian ini>
3. `tasks.md`: baris task-mu
4. `CLAUDE.md` repo yang disentuh

## Kontrak

`Contract: Confluence <id> "<title>" v<version>` (diambil <tanggal>), atau `Contract: not found (searched: <daftar>)`.
Kalimat yang mengikat tiket ini:
> <kutipan>

## Acceptance criteria

Satu kapabilitas per baris, sama persis dengan `ac.txt` dan baris AC di ledger.

1. <AC>
2. <AC>

## Scope

- Entry point: <create / edit / direct save / reopen-refresh / data tersimpan lama>
- File yang diubah: <path>
- Test: <file test dan kasusnya, termasuk default dan data lama>
- Docs yang ikut: <path atau "tidak ada">

## Yang tidak boleh berubah

- <perilaku lama yang tetap>

## Aturan menulis

- Diff sekecil mungkin; tanpa komentar atau JSDoc tambahan, juga di test.
- Tanpa rename, format ulang, urutan import, refactor di luar AC; jangan melebarkan tipe atau mengubah helper bersama (tambah argumen opsional dengan default perilaku sekarang).
- Pakai yang sudah ada sebelum membuat yang baru. Kode dan test dalam bahasa Inggris.

## Bukan milikmu

`package.json`, lockfile, `.github/`, `.husky/`, `.env*`, `CLAUDE.md`, `AGENTS.md`: <BLOCKED dan alasannya, atau "tidak dibutuhkan">

## Terrain

**Bisa:**
- <apa yang bisa dibangun dari yang sudah ada> (`path`)

**Tidak bisa:**
- <apa yang tidak bisa dikerjakan run ini> - <kenapa>

**Concern:**
- <risiko> - <blast radius: pemanggil lain, bentuk data, migrasi, data produksi>

## Kalau terblokir

Tulis `ISSUE <BLOCKER|QUESTION|RISK|DISPUTE>: <satu baris>` di laporanmu; runner mencatatnya di ledger dan arbiter memutusnya. Lanjutkan yang tidak terblokir.

## Selesai berarti

| AC | path:line | test |
|---|---|---|
| 1 | | |
