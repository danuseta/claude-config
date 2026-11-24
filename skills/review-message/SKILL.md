---
name: review-message
description: Write the chat message the user sends to a teammate whose PR was just reviewed. Use at the end of every review-pr run, and whenever the user asks "gimana gue bilangnya", "buatin kalimat buat mas X", or wants a review result worded for the author.
---

# Message to the author of a reviewed PR

The review report is for the user. This is the short text the user pastes into chat for the teammate. The user sends it; never post it anywhere yourself.

## Rules

1. **Address the author as "mas".** Open with `mas <name>` when the name is known (`mas aken`), plain `mas` otherwise. Use "mas" again inside the text where a pronoun would go, never "lu", "kamu" or "bro".
2. **Lowercase everything**, including the first letter, names and ticket keys in running text (`qrd-1396`). Only code identifiers, file names and paths keep their real casing, because they must match the code (`chatStore setActiveRoom`, `RoomService.ts`).
3. **Casual Indonesian**, the way the team chats. No dashes as connectors, no bullet symbols, no bold, no emoji.
4. **The blocker is the message.** The first sentence says the blocker status, every time.
   - Blocker: `ada blocker <n>, belum bisa approve`, and then the message talks about the blockers ONLY. Each one is numbered `1)`, starts with the word `blocker`, says which part it is in (`fe:`, `be:`, `gateway:`), quotes the AC or contract sentence it breaks, gives the `file:line`, and refers to its screenshot as `gambar N` when it is visible on screen. No non-blocking notes at all: they stay in the report for the user and go out in a later message once the blocker is settled. A point without a quoted AC or contract sentence is a note, not a blocker, and therefore does not appear. A contract sentence that only sets sprint scope or timing ("not built this sprint", "do not start") is also a note, not a blocker, when the ticket's AC asks for the thing and nothing is broken: a blocker is an unmet AC or broken behaviour.
   - No blocker: `gak ada blocker`, then the notes, numbered `1)`, `2)`, `3)`, one line each, three at most, only things the author can act on, each saying which PR or part it is about when the ticket has more than one.
5. **Say which part is lgtm, by name.** Never a bare `lgtm`. Name what was checked and is fine, in the author's terms: per PR when the ticket has several (`be sama gateway lgtm, kontrak /chats/unread udah cocok`), per behaviour when it has one (`urutan, scroll per section, sama collapse lgtm`). Things actually verified, no adjectives; a part that carries a blocker or a note is not listed as lgtm. Without a blocker this comes right after the status. With a blocker it comes last, as one short closing sentence (`sisanya lgtm: ...`), so the blocker is what the author reads first.
6. **Attachments are dark-mode screenshots.** A `-light.png` is attached only when the point is about light mode itself.
6b. **Screenshots only for blockers, called "gambar N".** Attach a screenshot only to a blocker it proves; a non-blocking note, a nit or an lgtm part never gets one. In the text call it `gambar 1`, `gambar 2`, numbered in the order they are first mentioned: `edit meta template (gambar 3)`, two as `gambar 1 buat new agent tool, gambar 2 buat ?file=`. Never write a file name in the text, and never a label such as "ss 1a" or "ss terlampir": Discord shows attachments without their names. Two images per blocker at most, ten per message.
7. **A message without a blocker has no images.** The lgtm clause says in words what was checked; the screenshots stay in the report for the user.
8. **Make attaching one step.** Copy exactly the images the message refers to into `E:/qonflo/<MMDD>/kirim-<ticket>/` (lowercase ticket, e.g. `kirim-qrd-1269`), keeping their file names, and give that folder under the message. The folder holds nothing else, so the user selects everything in it. Never move or rename the originals.
8b. **On the Linux workspace (DOCK chat), attach the images themselves, not a folder path.** The user reads the reply in DOCK and saves the images from there. Copy the named images into `/home/coder/projects/.evidence/<MMDD>/kirim-<ticket>/`, then under the message write one `DOCK_ATTACH: <absolute path>` line per image, in `gambar N` order. DOCK only sends files inside the working folder `/home/coder/projects`, so a copy under `~/qonflo-out` or anywhere else outside it is refused and never reaches the chat. Leave out the `Lampirkan` block there.
8c. **Inside a DOCK `<<<DISCORD` block** (DOCK posts it to the thread), write no `Lampirkan` or `DOCK_ATTACH` lines. Under the text put one line per image, `GAMBAR N: <file name> | <short caption>`, the file name only, from the ticket blackboard's `screenshots/` folder, the caption about 40 characters. DOCK stamps "GAMBAR N" and the caption on a strip above the image and uploads them in number order.
9. One message per ticket. Several PRs of one ticket share one message.

## Output shape

Give the user exactly this, nothing drafted around it:

```
<ticket> (<PRs>): <Approve | Approve with comments | Request change>

> <the message, ready to paste>

Lampirkan (semua isi folder ini): <absolute path of the kirim folder>
- gambar 1: <file name>
- gambar 2: <file name>
```

On the Linux workspace the `Lampirkan` block is replaced by the attachments themselves:

```
DOCK_ATTACH: /home/coder/projects/.evidence/<MMDD>/kirim-<ticket>/<file name of gambar 1>
DOCK_ATTACH: /home/coder/projects/.evidence/<MMDD>/kirim-<ticket>/<file name of gambar 2>
```

Leave out the `Lampirkan` block when no blocker has a screenshot. If an FE blocker has no screenshot yet, say that in one line under the message instead of pretending there is one.

## Examples

No blocker (no images):

> mas aken, gak ada blocker. urutan channel, chat tabs, status, tags udah bener, scroll per section sama layar pendek juga lgtm. catatan: 1) diff-nya kebawa format ulang satu file (urutan class tailwind, contohnya CountBadge), bisa dipangkas biar isinya cuma reorder mas? 2) job test di ci merah dari chitchat-qr-modal.test, bukan dari pr ini, tinggal re-run.

With a blocker (blockers only, lgtm last, no notes):

> mas indra, ada blocker 1, belum bisa approve. 1) blocker, be: ac "created, renamed, moved, and deleted" tapi delete belum ada, folder.service.ts:212 cuma handle tiga yang lain, di menu folder juga gak ada opsi delete (gambar 1). sisanya lgtm: create, rename, sama move.

Lampirkan (semua isi folder ini): E:/qonflo/1005/kirim-qrd-1056/
- gambar 1: 03-folder-menu-dark.png

In a DOCK block (qrd-1569):

```
<<<DISCORD
mas indra, ada blocker 2, belum bisa approve. 1) blocker, fe: ... link ke item di root playbook sekarang jatuh ke lab root, gambar 1 buat new agent tool, gambar 2 buat ?file=. ada di playbook.tsx:758-774. 2) blocker, fe: ... edit meta template (gambar 3) sama edit automated message (gambar 4) belum ada crumb lab. sisanya lgtm: lab root lima folder sama urutannya.
GAMBAR 1: 10-tool-noparent-agent.png | New Agent tool dari Lab root
GAMBAR 2: 11-file-noparent.png | ?file= gak kebuka
GAMBAR 3: 15-probe-meta-template-edit.png | Edit Meta Template tanpa crumb Lab
GAMBAR 4: 15-probe-automated-message-edit.png | Edit Automated Message tanpa crumb Lab
<<<AKHIR DISCORD>>>
```

## Never

- Uppercase letters outside code identifiers and paths.
- Calling something a blocker without the AC or contract sentence it breaks.
- A non-blocking note in a message that has a blocker.
- More than three points, or a point that needs a paragraph. That belongs in the report.
- A bare `lgtm` that does not say what is fine.
- A screenshot for a non-blocking note, a nit or an lgtm part, or attaching every screenshot taken.
- A file name, a label or "terlampir" in the text instead of `gambar N`.
