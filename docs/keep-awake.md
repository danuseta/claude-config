# Menjaga workspace tetap hidup selama chat

Coder menghentikan workspace 8 jam setelah start. Chat dari HP bisa terpotong kalau itu terjadi di tengah turn. Perpanjangan otomatis hanya jalan selama ada turn chat aktif.

## Siapa bisa apa

| Identitas | Bisa | Tidak bisa |
|---|---|---|
| Token agent (sudah ada di workspace) | API agent: metadata, log, status aplikasi | Memperpanjang workspace |
| Token pengguna `danuseta` | Semuanya, karena role Owner | - |

## Tiga jalur

| Jalur | Cara | Kredensial baru | Dipakai kalau |
|---|---|---|---|
| M1 | Bridge melapor status aplikasi lewat `PATCH $CODER_AGENT_URL/api/v2/workspaceagents/me/app-status`. Coder menaikkan deadline saat status `working` | Tidak ada | Spike S4 lulus |
| M2 | DOCK memperpanjang lewat `PUT /api/v2/workspaces/{id}/extend` | Token Coder disimpan di DOCK | S4 gagal |
| M3 | Bridge memperpanjang sendiri | Token Coder di `secrets.env` workspace | Tidak dipilih; hanya dengan izin eksplisit owner |

## Aturan yang sama untuk M1 dan M2

| Hal | Nilai |
|---|---|
| Pemicu | Saat turn diklaim, lalu tiap 10 menit selama turn berjalan |
| Besar (M2) | Pastikan deadline minimal sekarang + 90 menit; panggil hanya kalau sisa kurang dari 60 menit. Panggilan tidak menumpuk |
| Besar (M1) | Sebesar activity bump template, 1 jam, tidak bisa diatur dari sini |
| Batas | Satu perpanjangan per 10 menit per mesin |
| Berhenti | Tanpa turn tidak ada panggilan. Workspace berhenti paling lama 90 menit setelah turn terakhir |
| Gagal | Dicatat di log. Turn tidak dibatalkan |
| Batas Coder | Deadline tidak bisa melewati batas template. Penolakan dicatat paling banyak sekali per jam |

## Spike S4

Dijalankan lead, tidak butuh DOCK atau tailnet.

1. Catat `latest_build.deadline` (D0) lewat `coder_get_workspace`.
2. Cari slug app dengan `coder_workspace_list_apps`, lalu di workspace kirim `PATCH` ke `app-status` dengan `state: "working"`. Harapannya `200`.
3. Baca deadline lagi. D1 lebih besar dari D0 berarti M1. Sama berarti M2.
4. Kirim `state: "idle"`. Harapannya `200`.

## Kalau M2 dipakai

Owner membuat token `dock-extend` dan mengisinya di DOCK > Settings (gate G9). Langkahnya ada di `secrets.md`.
