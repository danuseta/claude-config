# Rollback

| Sasaran | Langkah |
|---|---|
| Workspace seperti sebelum repo ini | 1. `ccfg stop all`. 2. `rm ~/personalize`. 3. `ccfg uninstall` (menghapus file yang tercatat di `~/.local/state/claude-config/installed.txt`, mengembalikan `settings.json` dari cadangan tertua, menghapus kit, `CLAUDE.md`, biner yang dipasang, state Tailscale, dan `~/.config/claude-config`). 4. `claude plugin uninstall` untuk empat plugin. 5. `claude mcp remove` untuk server yang ditambahkan. 6. `rm -rf ~/claude-config ~/brain`. Milik template tidak disentuh: `rules/`, `skills/graphify`, `skills/playwright-cli`, MCP `mongodb` |
| Tailnet | Admin > Machines > hapus `coder-danu`. Cabut auth key kalau belum terpakai. Kembalikan ACL dari riwayat versi |
| Token DOCK | DOCK > Settings > Revoke token `workspace` |
| Laptop | Salin balik isi `C:/Users/danus/.claude-kantor/backups/pre-claude-config-<tanggal>/`. Hapus `secrets.local.json`. `kit/dock.json` tidak pernah diubah |
| `DOCK_PIN_MODE` | Kembalikan ke `auto` hanya setelah node `coder-danu` dihapus dari tailnet |
| Repo ini | Arsipkan atau hapus di GitHub setelah langkah di atas |

## DOCK

| Jalur | Langkah | Akibat |
|---|---|---|
| Aman | Hentikan container, kembalikan `jidis.db` dari `jidis.db.bak-pre-machine`, jalankan image tag sebelumnya (`DOCK_IMAGE_TAG=<lama>`) | Data sejak deploy hilang |
| Tanpa kehilangan data | Jalankan image lama sekali dengan `npx prisma db push --skip-generate --accept-data-loss --schema backend/bff-graphql/prisma/schema.prisma && node backend/bff-graphql/dist/index.js` | Hanya kolom `machine` dan satu index yang dibuang. Uji dulu di salinan DB |

Image lama menjalankan `prisma db push` dengan skema lama. Tanpa cadangan, jangan rollback image begitu saja.
