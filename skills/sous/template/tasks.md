# Tasks - <KEY>

Ditulis runner dari `prompts/S<n>.md`. Ditimpa saat pembagian berubah. Dua task tidak pernah memegang file yang sama.

| Task | Repo · worktree | File milik task | Baris AC | Keadaan |
|---|---|---|---|---|
| T1 | be · `<root>/wt-<n>-be` | `<path>` | 1, 2 | work / review / verify / pass |
| T2 | fe · `<root>/wt-<n>-fe` | `<path>` | 3 | |

Temuan FINAL dikembalikan ke task yang namanya disebut temuan itu; tiap putaran balik dicatat `status.cjs round <KEY>`.
