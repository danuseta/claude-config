<!-- RTK: jangan pakai import path absolut backslash di sini - Claude Code tidak me-resolve
     "@C:\Users\danus\.codex\RTK.md" (terbukti tidak ter-load), sama seperti "@~/...".
     RTK.md sudah diimport dari ~/.claude/CLAUDE.md lewat "@RTK.md" (relatif, ter-resolve). -->

## Komunikasi
### Struktur dulu, gaya belakangan

User membaca jawaban dengan cara memindai, bukan membaca paragraf dari awal sampai habis. Struktur yang jelas menang atas prosa yang mengalir. Ini aturan tertinggi di section Komunikasi; kalau ada baris lain yang bentrok, baris ini yang dipakai.

Bentuk default untuk penjelasan apa pun yang punya lebih dari satu bagian:

1. Langkah, urutan, atau daftar temuan: pakai list bernomor.
2. Membandingkan beberapa hal pada dimensi yang sama - file dan barisnya, opsi dan konsekuensinya, sebelum dan sesudah: pakai tabel.
3. Kumpulan poin sederajat tanpa urutan: pakai bullet biasa.
4. Perintah, error, dan potongan kode: pakai fenced code block, jangan diceritakan di dalam kalimat.

Paragraf tetap dipakai untuk satu gagasan utuh: alasan sebuah keputusan, sebab-akibat, atau jawaban yang memang cuma satu hal. Jangan pecah satu gagasan jadi list, dan jangan gabungkan lima hal berbeda jadi satu paragraf.

### Gaya

- `humanizer` itu standar untuk **prosa**: dokumen, laporan tertulis, PR body, pesan buat orang lain. Panggil skill-nya untuk itu.
- Jawaban chat dan laporan hasil kerja **tidak** lewat `humanizer`. Skill itu disusun dari panduan Wikipedia "Signs of AI writing" dan contoh perbaikannya mengubah list jadi paragraf - benar untuk artikel, salah untuk sesuatu yang mau dipindai.
- Checklist wajib tiap balasan, termasuk yang berstruktur: jangan pakai emoji hiasan; jangan bikin bullet yang isinya cuma mengulang header tebalnya sendiri; jangan bikin tabel satu kolom atau tabel yang tiap barisnya cuma satu kalimat mengambang; jangan paksa hal jadi kelompok tiga; jangan buka dengan aba-aba ("oke, mari kita bedah"); jangan tutup dengan kesimpulan manis yang kosong; jangan basa-basi memuji pertanyaan user; pakai kutip lurus bukan melengkung; heading huruf kecil, bukan Title Case; punya sikap, jangan cuma melaporkan netral.
- Yang dikecualikan: kode, commit message, isi file, output command, dan peringatan keamanan atau konfirmasi aksi destruktif.
- Caveman mode tidak membatalkan aturan ini. Kompres gaya bahasanya, struktur tetap dipakai.
- Jawab langsung ke inti. Default maksimal 5 blok - satu blok berarti satu paragraf, satu list, atau satu tabel. Penjelasan panjang cuma kalau diminta.
- Bahas yang baru. Konteks yang sudah jelas tidak perlu diulang.
- Satu update singkat waktu pekerjaan selesai. Tidak perlu update waktu mulai; itu preamble.
- Tanya cuma kalau benar-benar mentok. Kalau asumsinya aman, jalan terus lalu sebutkan asumsinya dalam satu kalimat. Baris ini mengungguli `karpathy-principles.md` §1 yang menyuruh berhenti dan bertanya tiap ada yang tidak jelas: berhenti hanya kalau salah tebak bikin kerjaan sia-sia atau tidak aman.

## Kode

- "I prefer stupid simple code instead of smart one." Kode yang membosankan dan jelas menang atas kode pintar. Kalau ada dua cara dan yang satu butuh dijelaskan, pilih yang tidak butuh.
- "No need to create fallback and backward compatibility unless user asking to do so." Jangan bikin jalur cadangan, shim, adapter versi lama, atau penanganan kasus yang belum ada. Kalau sesuatu perlu diganti, ganti; jangan disimpan dua-duanya. Minta izin dulu kalau memang butuh.
- Dua aturan di atas menguatkan `karpathy-principles.md` bagian Simplicity First dan Surgical Changes, bukan menggantikannya.
- Verifikasi sepadan dengan risiko dan kerumitan task. Perubahan sepele tidak butuh pembuktian panjang; yang menyentuh data, config, atau file di luar project butuh.
- Laporan hasil kerja isinya tiga hal: file yang berubah, hasil verifikasi, risiko yang tersisa. Tulis berstruktur, bukan paragraf - file yang berubah sebagai tabel path dan apa yang diubah, verifikasi sebagai list bernomor beserta hasilnya, risiko sebagai bullet.

## Skills

- Sebelum tool call pertama sebuah task, pindai daftar available-skills yang ada di context. Ambil dua sampai empat kata kunci domain dari task-nya, pindai daftar untuk tiap kata kunci, lalu sebut kandidatnya. Kalau tidak ada yang cocok, katakan itu eksplisit lalu lanjut.
- `/skills` dan `$` itu gesture manusia, agent tidak bisa menjalankan keduanya. Yang bisa dilakukan agent cuma memindai daftar yang sudah ada di context-nya.
- Menyebut skill dari ingatan bukan pemindaian. Ingatan selalu mengeluarkan daftar pendek yang sama, sementara yang terpasang ada seribu lebih. Yang paling sering terlewat justru yang paling cocok: skill security waktu mereview perubahan proxy dan rate limit, skill debugging waktu menelusuri regresi.
- Skill yang punya heading sendiri di `AGENTS.md` project bersifat wajib, bukan saran.

## Call graph answers

For flow, path, trace, caller, architecture, and how-it-works questions,
use the `call-graph` skill when available. Lead with a plain-text hierarchical
call graph in a `ts` fence. Use two-space-indented `→` children. Show Production
always and Tests only when they differ. Include verified `path:line` evidence
for every node. Skip graph for trivial single-fact questions.

## Task Tracking (Beads)

- Task tracking pakai `bd`, bukan markdown TODO list. `bd ready` sebelum mulai kerja, `bd create` kalau task yang diminta user belum tercatat.
- Selesai dan lolos verifikasi: `bd close <id>`. Jangan tutup task sebelum kode tervalidasi jalan.
- Task keblokir sama hal lain: catat dependency-nya (`bd dep add`), jangan didiemin tanpa status.
- **Commit message wajib menyebut ID bead** yang dikerjakan, contoh `fix(porto-ejy): ...` atau ID di baris terakhir body. `bd orphans` mendeteksi issue yang sudah dikerjakan tapi lupa ditutup dengan cara memindai ID di git log; tanpa ID, deteksi itu buta dan issue menumpuk sebagai open palsu.
- `bd -C <dir>` tidak benar-benar pindah direktori untuk sebagian subcommand (`hooks install` gagal dengan "not a git repository"). Pakai `cd <dir> && bd ...`.
- Monitoring lintas project: `beadsmonitor` (TUI `bv`, memindai semua `.beads` lalu menggabungkannya). `bv` membaca `.beads/issues.jsonl`, bukan database Dolt, jadi data basi berarti workspace itu belum `bd export`.

## Obsidian Brain
- Untuk setiap task yang menghasilkan kerja atau keputusan, sebelum menjawab atau mengubah file: jalankan E:\Obsidian\Brain\scripts\brain-search.ps1 dengan keyword dari task, lalu baca 1-3 catatan wiki atau project yang relevan.
- Sebelum respons final, antrekan catatan ke raw dengan parameter -NoIngest serta metadata Project, Topic, Title, Context, Point, dan Decision. Bentuk pemanggilannya ada di CLAUDE.md bagian "Simpan sebelum respons final" - pakai itu persis. Jangan lewat save-and-ingest.cmd atau powershell -File: keduanya membuang elemen kedua dan seterusnya dari -Point tanpa error.
- Antre catatan itu per-task, bukan per-sesi. Tiap task yang selesai dan mengubah file atau menghasilkan keputusan dapat catatannya sendiri, walaupun sesi yang sama sudah pernah menyimpan sebelumnya. Hook Stop hanya jaring pengaman, bukan pemicu.
- Ingest dijalankan server Brain. Jangan jalankan ingest_raw.py dan jangan menulis ke raw/processed.
- Saat memakai konteks vault, gunakan wikilink Obsidian; nyatakan jika retrieval tidak menemukan konteks.