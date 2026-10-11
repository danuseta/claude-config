# Secret

Repo tidak menyimpan nilai secret. File konfigurasi hanya berisi placeholder `{{secret:NAMA}}`.

## Tempat secret per mesin

| Mesin | File | Format |
|---|---|---|
| Laptop | `C:/Users/danus/.claude-kantor/secrets.local.json` | JSON, nama ke nilai. Dibuat sekali dengan `node install/install.cjs --extract-secrets` |
| Workspace | `/home/coder/.config/claude-config/secrets.env` | `KEY=VALUE`, mode 600 |

## Nama yang dipakai

| Nama | Dipakai oleh | Wajib |
|---|---|---|
| `DOCK_INGEST_URL`, `DOCK_INGEST_TOKEN` | Hook dan bridge DOCK di workspace | Ya |
| `TYPESAFE_API_KEY` | Plugin typesafe | Ya |
| `TS_AUTHKEY` | Join Tailscale pertama; dihapus otomatis setelahnya | Sekali |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | MCP github | Di workspace dari `gh auth token` |
| `EXA_API_KEY`, `FIRECRAWL_API_KEY` | MCP exa dan firecrawl | Opsional |
| Token Coder `dock-extend` | Perpanjang workspace (jalur M2) | Hanya jika spike S4 gagal |

## Mengisi secret

1. Buka terminal workspace sendiri.
2. Jalankan `ccfg secret set <NAMA>`. Nilai dibaca tanpa tampil di layar.
3. Cek dengan `ccfg secret list`. Perintah ini hanya menampilkan nama.

Jangan tempel secret ke chat dengan Claude, ke DOCK, atau ke issue.

## Token Coder untuk perpanjangan (gate G9)

Hanya perlu kalau jalur M1 di `keep-awake.md` tidak berhasil.

1. Buat token: Coder > Settings > Tokens, atau `coder tokens create --name dock-extend --lifetime 720h`, dengan lingkup tersempit yang tersedia.
2. Isi di DOCK > Settings. Token tersimpan terenkripsi di DOCK, bukan di workspace.
3. Kalau v2.38 tidak bisa membatasi token ke satu workspace, token itu setara kunci admin Coder. Putar tiap 30 hari.
4. Cabut dengan `coder tokens remove dock-extend`.

## Pemindaian sebelum push

`node install/secret-scan.cjs` harus berakhir dengan `0 findings`. Di laptop, pindai juga membandingkan dengan nilai asli dari file secret lokal. Di workspace lapisan itu dilewati.

## Kalau bocor

| Barang | Cabut |
|---|---|
| Token ingest DOCK | DOCK > Settings > Ingest tokens > Revoke |
| Auth key Tailscale | Admin > Settings > Keys > Revoke |
| State node Tailscale | Admin > Machines > hapus `coder-danu` |
| `TYPESAFE_API_KEY` | Putar di penyedia, lalu `ccfg secret set` |
| Token OAuth MCP | Cabut di akun Atlassian dan Figma |
| Token `gh` | `gh auth logout`, cabut di GitHub > Settings > Applications |
