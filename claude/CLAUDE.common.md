## RTK dulu, tool native belakangan

Urutannya selalu: **cari proxy rtk dulu, baru fallback**. Berlaku untuk semua pekerjaan, bukan cuma baca dan cari.

1. Ada proxy rtk-nya? Pakai itu lewat Bash.
2. Tidak ada proxy, gagal, atau outputnya terpotong sampai menyesatkan? Baru pakai tool native atau command mentah.

Cek daftar proxy dengan `rtk --help` sebelum menyimpulkan sesuatu tidak ada. Yang tersedia mencakup `read` `rg` `grep` `find` `ls` `tree` `wc` `diff` `json` `env` `deps`, `git` `gh` `glab`, `npm` `npx` `pnpm` `tsc` `lint` `prettier` `format`, `jest` `vitest` `playwright` `test`, `docker` `kubectl` `aws` `psql` `prisma` `curl` `wget`, `err` `log` `summary` `smart`.

Yang paling sering terlewat karena Claude Code punya tool sendiri:

- isi file: `rtk rg "<pola>" <path>`, bukan tool Grep
- baca file: `rtk read <path>`, bukan tool Read
- nama file: `rtk find` atau `rtk ls`, bukan tool Glob

Tool Read/Grep/Glob native tidak lewat shell sama sekali, jadi hook rtk tidak pernah kena dan outputnya keluar utuh tanpa dimampatkan.

Dua pengecualian yang wajar, bukan alasan malas:

- File yang akan diedit tetap harus dibaca lewat tool **Read** native, karena tool Edit mensyaratkan itu. `rtk read` tidak dihitung.
- `node -e`, `python`, dan `powershell -File ...` memang tidak punya proxy. Jalankan apa adanya.

## Berlaku juga di subagent dan worker

- Subagent yang dispawn lewat Agent/Task tool wajib patuh aturan rtk yang sama. Waktu menulis prompt untuk subagent, sebutkan eksplisit bahwa command shell lewat `rtk`.
- Worker CLI di pane tmux (`codex_worker`, `gemini_worker`, `antigravity_worker`) jalan di luar Claude Code, jadi hook rtk tidak pernah melihatnya. Tulis prefix `rtk` di dalam prompt yang dikirim ke worker.

Cek hasilnya berkala dengan `rtk gain`.

@RTK.md
