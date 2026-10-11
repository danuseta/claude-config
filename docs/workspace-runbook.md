# Runbook workspace

Panduan memasang dan merawat konfigurasi di workspace Coder `danu`. Perintah dijalankan di terminal workspace kecuali disebut lain.

## Yang dipasang saat workspace start

`~/personalize` adalah stub yang menjalankan `linux/personalize.sh` terlepas dari proses start. Skrip itu tidak pernah memblokir start dan tiap langkahnya boleh gagal sendiri.

| # | Langkah | Kalau gagal |
|---|---|---|
| 1 | Ambil lock, putar log | Keluar diam |
| 2 | Siapkan `PATH` dan toolchain Node | Langkah yang butuh Node dilewati |
| 3 | `git pull --ff-only` repo ini | Pakai checkout yang ada |
| 4 | Pasang biner (tailscale, rtk, bd, uv) di `~/.local/bin` | Fitur terkait mati |
| 5 | Cek `secrets.env` ada dan mode 600 | Langkah 7, 8, 10 dilewati |
| 6 | `node install/install.cjs --apply` | Konfigurasi lama tetap |
| 7 | Checkout atau `pull --ff-only` repo `qonflo-coord` di `~/projects` | Dilewati kalau pohon kerja tidak bersih |
| 8 | Jalankan `tailscaled` lewat `supervise.sh`, gabung tailnet | Bridge tetap dicoba |
| 9 | Uji jangkauan DOCK | Dicatat |
| 10 | Pasang plugin dan MCP dari `plugins/plugins.json` dan `mcp/mcp.linux.json` | Dicatat |
| 11 | Jalankan bridge chat | Dicatat |
| 12 | Tarik vault Brain | Vault bisa basi |

Nomor di atas hanya urutan baca. Urutan pasti ada di `linux/personalize.sh`.

## Repo qonflo-coord di ~/projects

`~/projects` sudah berisi clone repo aplikasi. Repo koordinasi `qonflo-coord` dipasang di akar yang sama, supaya `AGENTS.md`, `.claude/skills`, `scripts`, dan `.evidence` ada di tempat yang sama dengan laptop.

1. `git init` di `~/projects` kalau belum ada.
2. `git remote add origin <url qonflo-coord>`, lalu `git fetch`.
3. `git checkout -t origin/master`.
4. Skrip tidak pernah memakai `checkout -f`, `reset`, atau `clean`. Kalau pohon kerja tidak bersih, langkah dilewati dan log menyebutnya.
5. Aturan kerja blackboard sprint: `git pull --rebase` sebelum mengedit, commit per perubahan, push langsung.

## Perintah sehari-hari

| Perintah | Fungsi |
|---|---|
| `ccfg status` | Tailscale, bridge, versi biner, hasil langkah terakhir |
| `ccfg stop`, `ccfg start`, `ccfg restart` | Kendali `tailscale`, `bridge`, atau `all` |
| `ccfg update` | `git pull --ff-only`, `install.cjs --apply`, restart bridge |
| `ccfg secret set <NAMA>`, `ccfg secret list` | Lihat `secrets.md` |
| `ccfg doctor` | Menjalankan uji penerimaan |
| `ccfg uninstall` | Lihat `rollback.md` |

Log ada di `~/.local/state/claude-config/personalize.log` dan `~/.claude/kit/dock-chat.log`.

## Pengaturan pertama kali

1. Owner membuat ACL dan auth key Tailscale (gate G1).
2. Isi secret: `ccfg secret set TS_AUTHKEY`, `DOCK_INGEST_TOKEN`, `TYPESAFE_API_KEY`.
3. Restart workspace dari halaman Coder.
4. Login ulang MCP OAuth (atlassian, figma): dari laptop `coder port-forward danu --tcp <port>`, lalu di terminal workspace jalankan `claude`, `/mcp`, pilih servernya dan selesaikan login di browser laptop. Callback OAuth menuju `localhost` workspace, jadi tidak bisa dari HP.
5. Cek `ccfg doctor`.

## Batas workspace

Tidak ada systemd, cron, tmux, Docker, dan `/dev/net/tun`. Paket apt hilang tiap start. Port resmi: 3000, 5173, 5174, 5000, 3100. Test dijalankan dengan `--maxWorkers=40%`. Aturan lengkap untuk Claude ada di `claude/CLAUDE.linux.md`.
