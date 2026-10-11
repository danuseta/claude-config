---
name: chat-template
description: Use when drafting a chat message to a teammate, lead, or boss in Indonesian (Slack, WhatsApp, Teams, Discord) - status update, question, request, apology, handover, or follow up. Produces lowercase, hyphen free, "aku/mas" style text that reads like a real person typing, not a memo.
---

# chat template

Draft chat in Indonesian for a coworker. Four hard rules, then the writing craft.

## the four rules

**1. semua lowercase.** Awal kalimat, nama orang, nama branch, nama ticket, semuanya. Yang tetap kapital cuma isi code block, nama command, dan string error yang harus dicopy persis.

**2. "aku" dan "mas".** Sebut diri sendiri "aku", bukan "saya" atau "gue". Lawan bicara "mas" atau "mbak". Sapaan jangan selalu di depan; lebih sering enak diselipkan di tengah atau akhir kalimat.

Contoh: "aku hari ini ngerjain fitur A mas" lebih natural daripada "mas, saya hari ini mengerjakan fitur A".

**3. tanpa tanda hubung.** Nol karakter `-` di seluruh pesan. Berlaku juga untuk em dash dan en dash.

Nomor ticket ditulis dengan spasi: `qrd 1014`, bukan `qrd-1014`. Nama branch dan file yang memang mengandung hubung ditaruh di code block, atau kalimatnya diputar supaya tidak perlu disebut. Kata majemuk pilih bentuk tanpa hubung: "was was", "cut off", "follow up".

**4. lolos humanizer.** Jangan panggil skill `humanizer` untuk chat pendek, cukup patuhi checklist di bawah. Panggil skill aslinya kalau pesannya panjang atau bakal dipakai berulang.

## checklist humanizer untuk chat

Buang:

- pembuka seremonial: "izin bertanya", "mohon maaf mengganggu waktunya", "sebelumnya terima kasih atas"
- penutup kosong: "sekian terima kasih", "semoga bisa dimengerti", "mohon arahannya"
- bullet berkepala tebal titik dua
- emoji hiasan dan bold
- kutip melengkung, pakai kutip lurus
- hedging bertumpuk: "sepertinya mungkin agak"
- pengelompokan paksa jadi tiga hal
- kalimat pasif yang menyembunyikan pelaku: "sudah dilakukan merge" jadi "aku udah merge"

Pertahankan:

- panjang kalimat yang berubah ubah, jangan seragam
- sikap yang jelas, bukan laporan netral. kalau khawatir, bilang khawatir
- angka dan nama konkret, bukan "beberapa perubahan"

## bentuk pesannya

Buka dengan hal yang sebenarnya mau dibilang. Kalau nanya, kalimat pertama pertanyaannya. Kalau lapor, kalimat pertama hasilnya.

Kasih fakta secukupnya supaya lawan bicara bisa jawab tanpa balik nanya: nomor ticket, nomor pr, kapan kejadiannya, di branch mana.

Kalau ada risikonya, sebut risikonya, bukan cuma minta tolong. Orang bergerak karena tahu apa yang rusak kalau dibiarkan.

Tutup dengan permintaan yang eksplisit. "boleh dibantu tarik #791 masuk deploy selasa mas?" bukan "mohon arahannya".

Satu topik satu pesan. Kalau ada dua urusan yang tidak nyambung, kirim dua pesan.

Kalau butuh nada minta maaf, satu kalimat cukup, terus langsung ke rencana perbaikannya. Minta maaf berulang bikin orang harus menenangkan kamu dulu sebelum bisa kerja.

## contoh

Nanya sambil bawa konteks yang bikin orang bisa langsung memutuskan:

```
mas, mau nanya soal cut off merge ke develop. itu kemarin malam atau nanti malam ya?

soalnya tadi siang aku merge fix bug qrd 1014 ke develop, pr #791. kalau cut off nya kemarin berarti punyaku telat.

yang bikin aku agak was was, versi awal qrd 1014 (pr #751) udah masuk kemarin siang, dan di versi itu organize nya masih bikin component or numpuk sama trigger. fix nya baru masuk hari ini. jadi kalau yang kebawa deploy selasa cuma #751, bug nya malah ikut naik ke production.

kalau memang udah lewat, boleh dibantu tarik #791 masuk deploy selasa mas? isinya cuma fix, gak ada fitur baru.
```

Update harian:

```
mas, hari ini aku kelarin fitur export excel di halaman report. udah aku push ke branch qrd 1122, tinggal nunggu review.

satu yang masih ngeganjel, kolom tanggal di file hasil export ikut timezone browser, jadi user di wib sama di wita bisa beda sehari. aku belum ubah karena kayaknya perlu diputusin dulu mau pakai timezone apa. besok aku lanjut kalau udah ada jawabannya.
```

## output

Kirim teksnya dalam satu code block supaya gampang dicopy. Kalau ada versi pendek dan versi panjang, kasih dua block terpisah dengan satu baris keterangan kapan masing masing dipakai. Jangan tambahkan penjelasan panjang di luar block.
