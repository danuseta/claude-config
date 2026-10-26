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
   - Blocker: `ada blocker <n>, belum bisa approve`, and then the message talks about the blockers ONLY. Each one is numbered `1)`, starts with the word `blocker`, says which part it is in (`fe:`, `be:`, `gateway:`), quotes the AC or contract sentence it breaks, gives the `file:line`, and names its screenshot when it is visible on screen. No non-blocking notes at all: they stay in the report for the user and go out in a later message once the blocker is settled. A point without a quoted AC or contract sentence is a note, not a blocker, and therefore does not appear. A contract sentence that only sets sprint scope or timing ("not built this sprint", "do not start") is also a note, not a blocker, when the ticket's AC asks for the thing and nothing is broken: a blocker is an unmet AC or broken behaviour.
   - No blocker: `gak ada blocker`, then the notes, numbered `1)`, `2)`, `3)`, one line each, three at most, only things the author can act on, each saying which PR or part it is about when the ticket has more than one.
5. **Say which part is lgtm, by name.** Never a bare `lgtm`. Name what was checked and is fine, in the author's terms: per PR when the ticket has several (`be sama gateway lgtm, kontrak /chats/unread udah cocok`), per behaviour when it has one (`urutan, scroll per section, sama collapse lgtm`). Things actually verified, no adjectives; a part that carries a blocker or a note is not listed as lgtm. Without a blocker this comes right after the status. With a blocker it comes last, as one short closing sentence (`sisanya lgtm: ...`), so the blocker is what the author reads first.
6. **Attachments are dark-mode screenshots.** A `-light.png` is attached only when the point is about light mode itself.
6b. **Attachments follow the comments, by file name.** Every screenshot is tied to the point (or the lgtm part) it proves, and that sentence names the file itself in brackets: `(gambar 02-dialog-member-default-checked-dark.png)`, two files as `(gambar 09-nonowner-before-open-dark.png, 10-nonowner-after-open-dark.png)`. File name only, no folder, exactly as on disk, so the author can match it to the attachment. Never a label such as "ss 1a" or "ss terlampir". Under the message, list the full paths in the order they appear in the message. A point with no screenshot gets none; a screenshot that supports no point or lgtm clause is not attached. Two images per point at most.
7. **An FE lgtm always carries the screenshot of the core feature.** When the FE part is lgtm, the lgtm clause names the one image that shows what the ticket is for, the thing a reader would point at and say "this is the feature" (the picker with not-ready rows for a tool-binding ticket, the reordered rail for a reorder ticket), not a side state such as an error or an empty list. It comes first in the message and first in the attachment list. If no screenshot shows the core feature, say so under the message instead of substituting another one.
8. **Make attaching one step.** Copy exactly the images named in the message into `E:/qonflo/<MMDD>/kirim-<ticket>/` (lowercase ticket, e.g. `kirim-qrd-1269`), keeping their file names, and give that folder under the message. The folder holds nothing else, so the user selects everything in it. Never move or rename the originals.
8b. **On the Linux workspace (DOCK chat), attach the images themselves, not a folder path.** The user reads the reply in DOCK and saves the images from there. Copy the named images into `/home/coder/projects/.evidence/<MMDD>/kirim-<ticket>/`, then under the message write one `DOCK_ATTACH: <absolute path>` line per image, core feature first, in message order. DOCK only sends files inside the working folder `/home/coder/projects`, so a copy under `~/qonflo-out` or anywhere else outside it is refused and never reaches the chat. Leave out the `Lampirkan` block there.
9. One message per ticket. Several PRs of one ticket share one message.

## Output shape

Give the user exactly this, nothing drafted around it:

```
<ticket> (<PRs>): <Approve | Approve with comments | Request change>

> <the message, ready to paste>

Lampirkan (semua isi folder ini): <absolute path of the kirim folder>
- <file name, core feature first>
- <file name, in the order they appear in the message>
```

On the Linux workspace the `Lampirkan` block is replaced by the attachments themselves:

```
DOCK_ATTACH: /home/coder/projects/.evidence/<MMDD>/kirim-<ticket>/<file name, core feature first>
DOCK_ATTACH: /home/coder/projects/.evidence/<MMDD>/kirim-<ticket>/<file name, in message order>
```

Leave out the `Lampirkan` block when the review has no FE part or no screenshots were taken. If an FE PR was reviewed and no screenshot exists yet, say that in one line under the message instead of pretending there is one.

## Examples

No blocker, FE with screenshots:

> mas aken, gak ada blocker. urutan channel, chat tabs, status, tags udah bener, scroll per section sama layar pendek juga lgtm (gambar 01-rail-order-dark.png, 05-tabs-scrolled-halfway-dark.png). catatan: 1) diff-nya kebawa format ulang satu file (urutan class tailwind, contohnya CountBadge), bisa dipangkas biar isinya cuma reorder mas? 2) job test di ci merah dari chitchat-qr-modal.test, bukan dari pr ini, tinggal re-run.

Lampirkan (semua isi folder ini): E:/qonflo/1005/kirim-qrd-1381/
- 01-rail-order-dark.png
- 05-tabs-scrolled-halfway-dark.png

With a blocker (blockers only, lgtm last, no notes):

> mas indra, ada blocker 1, belum bisa approve. 1) blocker, be: ac "created, renamed, moved, and deleted" tapi delete belum ada, folder.service.ts:212 cuma handle tiga yang lain, di menu folder juga gak ada opsi delete (gambar 03-folder-menu-dark.png). sisanya lgtm: create, rename, sama move.

Lampirkan (semua isi folder ini): E:/qonflo/1005/kirim-qrd-1056/
- 03-folder-menu-dark.png

## Never

- Uppercase letters outside code identifiers and paths.
- Calling something a blocker without the AC or contract sentence it breaks.
- A non-blocking note in a message that has a blocker.
- More than three points, or a point that needs a paragraph. That belongs in the report.
- A bare `lgtm` that does not say what is fine.
- An FE lgtm with no screenshot of the core feature, or with only error and edge-state images.
- Referring to a screenshot by a label or "terlampir" instead of its file name, or attaching every screenshot taken.
