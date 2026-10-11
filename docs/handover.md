# Memindahkan tiket antar mesin

Satu tiket dimiliki satu mesin pada satu waktu. DOCK menyimpan salinan ledger tiket (`ledgerRaw`), tapi hanya pemilik yang boleh mengubahnya. Tidak ada pengambilalihan diam-diam.

## Aturan

| Hal | Isi |
|---|---|
| Ledger dari mesin bukan-pemilik | Selalu diabaikan. DOCK membalas `ignored: true` dan menyebut pemilik |
| Pindah pemilik | Hanya lewat tindakan eksplisit, salah satu dari dua jalur di bawah |
| Token | Token ingest tiap mesin. Tidak ada kredensial baru |

## Jalur A: pemilik menawarkan, mesin tujuan menerima

1. Di mesin pemilik, push branch tiket dulu.
2. Jalankan `node <kit>/status.cjs handover KEY --to <mesin> [--note "..."]`. Perintah menolak kalau ada perubahan belum di-commit, branch tanpa upstream, atau commit belum di-push.
3. Halaman Agents di DOCK menampilkan "Offered to <mesin>". Mesin tujuan juga melihat satu baris di awal sesi.
4. Di mesin tujuan, jalankan `node <kit>/status.cjs pull KEY`. Ledger ditulis ke `<root>/.evidence/KEY/status.json` dan pemilik berpindah.
5. Ikuti perintah `prep-ticket.sh` yang dicetak untuk membuat worktree dan stack di mesin tujuan.

## Jalur B: owner memindahkan dari HP

Dipakai kalau mesin pemilik mati, misalnya laptop tertutup.

1. Buka halaman Agents, panel detail tiket, tekan "Move to <mesin>".
2. Baca peringatan di dialog. Hanya commit yang sudah ada di remote yang tersedia di mesin tujuan.
3. Di mesin tujuan, jalankan `status.cjs pull KEY`.

## Kalau ledger lokal berbeda dari server

| Keadaan saat `pull` | Tindakan |
|---|---|
| Tidak ada ledger lokal | Ditulis |
| Lokal tidak lebih baru dari server | Ditimpa |
| Lokal lebih baru | Ditolak dengan `REFUSED: local ledger is newer`. Salinan server ditulis ke `status.remote.json`. Dengan `--force`, lokal disimpan sebagai `status.local-<UTC>.json` lalu ditimpa |

## Yang tidak ikut pindah

| Barang | Alasan |
|---|---|
| Worktree, port, `node_modules`, `.env` | Per mesin; dibuat ulang oleh `prep-ticket.sh` |
| Tangkapan layar, video, log | Tinggal di mesin asal. Catatan `decisions` saat `pull` menyebut itu |
| Data dev Mongo | Per mesin |
| Sesi chat | Buat sesi baru di mesin tujuan dengan `ticketKey` yang sama |
| Blackboard sprint, Brain, beads | Lewat `qonflo-coord`, vault, dan `bd` |
