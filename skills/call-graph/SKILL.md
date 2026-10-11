---
name: call-graph
description: "Answer flow, path, trace, caller, and architecture questions with a verified plain-text call graph. Use for call graph, execution flow, request path, architecture trace, function callers, upstream or downstream behavior, 'How does X work?', 'What calls X?', 'Where does X go?', and production versus test flow comparisons. Also available on explicit $call-graph invocation. Do not use for trivial facts, port or version lookups, simple definitions, text edits, rename-only changes, or unrelated visual diagrams."
---

# Call Graph

Lead with the graph. Prose only explains what the graph cannot show.

## Workflow

1. Determine the requested scope. Graph that, nothing more.
2. Read repository instructions (`AGENTS.md`, `CLAUDE.md`) for local conventions.
3. Find the real entry point, its callers, and its callees with focused source navigation.
4. Inspect production wiring.
5. Inspect tests only when the test graph may differ.
6. Build the hierarchy using real symbol names.
7. Verify every node and attach `path:line` evidence.
8. Explain only conditions, retries, errors, and gotchas the graph cannot show.
9. Stop when the requested scope is covered.

## Navigation

Prefer, in order: language-server navigation, `rg`, `ast-grep`, the compiler or type checker, targeted tests.

Never guess a path, symbol, caller, test topology, or line number. If you cannot verify a node, say so instead of inventing it.

## Output

Full grammar and worked examples: `references/output-format.md`.

Shape:

    graph: short title

    Production:
    ```ts
    EntryPoint
      → ComponentA
        → ComponentA.method
    ```

    src:
      EntryPoint → path/to/file.ts:LINE
      ComponentA → path/to/component.ts:LINE

Rules that matter most:

- Plain text only. No Mermaid, no rendered diagrams.
- `ts` fence, two-space-indented `→` children. Root has no arrow.
- Real functions, methods, services, jobs, queues, stores.
- Production always. Tests only when the graph differs, and never invented.
- One evidence line per unique node.
- Mark planned nodes `[new]`. Never invent a future line number.
- Skip the graph entirely for a trivial single-fact question.
