# Output format

## Contract

    graph: short title

    Production:
    ```ts
    EntryPoint
      → ComponentA
        → ComponentA.method
          → [condition] ComponentB
            → {queue_or_store}
    ```

    Tests:
    ```ts
    TestEntryPoint
      → ComponentATestLayer
        → ComponentA.method
          → ComponentBTestLayer
    ```

    src:
      EntryPoint → path/to/file.ts:LINE
      ComponentA → path/to/component.ts:LINE
      ComponentA.method → path/to/component.ts:LINE
      ComponentB → path/to/other.ts:LINE

## Grammar

| Element | Meaning |
|---|---|
| root line, no arrow | entry point of the requested scope |
| two-space indent | one level deeper in the call hierarchy |
| `→ Name` | a call to `Name` |
| `[condition]` | the call happens only under that condition |
| `{name}` | a queue, store, topic, or other non-function sink |
| `[new]` | a node that does not exist yet, planned only |

## Rules

- Plain text only. No Mermaid, no image, no rendered diagram.
- Always a `ts` fence, even for non-TypeScript code. It is for highlighting, not language.
- Indentation carries the hierarchy. Do not draw box characters or connector lines.
- Use actual symbol names as they appear in source. No paraphrasing.
- Show `Production` always. Show `Tests` only when the test graph really differs.
- Never invent a test graph. If tests were not read, omit the section.
- `src:` lists every unique node exactly once, with verified `path:line`.
- A node marked `[new]` gets no line number. Never invent a future one.
- Skip the graph entirely when the question is a single fact, such as a port or a version.

## Worked example

Question: "How does token refresh work?"

    graph: token refresh on expired access token

    Production:
    ```ts
    AuthMiddleware.handle
      → TokenStore.read
        → {redis:session}
      → [access token expired] AuthService.refresh
        → OAuthClient.exchangeRefreshToken
          → [429] RetryPolicy.exponential
        → TokenStore.write
          → {redis:session}
      → [refresh token expired] AuthMiddleware.reject
    ```

    src:
      AuthMiddleware.handle → src/http/auth-middleware.ts:41
      TokenStore.read → src/auth/token-store.ts:18
      AuthService.refresh → src/auth/auth-service.ts:77
      OAuthClient.exchangeRefreshToken → src/auth/oauth-client.ts:112
      RetryPolicy.exponential → src/http/retry.ts:9
      TokenStore.write → src/auth/token-store.ts:34
      AuthMiddleware.reject → src/http/auth-middleware.ts:88

    A 429 from the provider retries three times before the error surfaces; every
    other 4xx fails immediately.

The prose at the end carries only what the graph cannot: the retry count and the
distinction between 429 and other 4xx.

## When production and tests differ

Show both only when the wiring is genuinely different, typically when tests
substitute a layer or a fake:

    Production:
    ```ts
    HTTP handlers
      → ComponentA
        → ComponentA.layerX
          → ComponentB
    ```

    Tests:
    ```ts
    HTTP handlers
      → ComponentA
        → componentMemoryLayer
          → ComponentA.layer
            → ComponentB.layerMemory
    ```
