# Token-count convention: the fresh/Anthropic shape is mandatory for all parsers

> **Status:** Resolved (FEA-2082). **Audience:** anyone touching a harness parser
> (`apps/desktop/src/main/collectors/`) or the shared cost engine
> (`packages/loops-api/src/genai-cost.ts`).

## Problem

Codex/OpenAI sessions produced `token_cost.pricing_miss` events with reason
`compute_error`. `@pydantic/genai-prices` treats `Usage.input_tokens` as the
GRAND TOTAL prompt (uncached + cached) and derives
`uncached = input_tokens − cache_read − cache_write`, throwing
"Uncached text input tokens cannot be negative" when that is < 0. Our cost engine
caught that throw and reported `compute_error`.

## Root cause

All desktop parsers store token counts in the **fresh shape** — `input` is the
UNCACHED count, with `cacheRead`/`cacheWrite` as SEPARATE additive components.
But the cost engine only treated `anthropic` as additive
(`CACHE_ADDITIVE_PROVIDERS`); for everything else it passed `input` through
unchanged. So for a Codex row (`provider = openai`) stored as fresh, the library
re-subtracted cache from an already-uncached `input` → negative → `compute_error`.
This fires whenever cache-hit rate > 50%, the normal Codex steady state.

## Decision

We considered switching the Codex parser to the OpenAI/inclusive shape
(`input` = total). Rejected: the dashboards (desktop analytics + the cloud
synced-session detail in `packages/api/src/agent-session-detail-projection.ts`)
**hard-depend on the fresh shape** — they compute totals as
`input + cacheRead + cacheWrite` and cache-rate as `cache / (total + cache)`. An
inclusive `input` would double-count cached tokens everywhere.

So the **fresh/Anthropic shape is the mandatory internal contract for every
parser**, and the cost engine is **always additive**.

## The contract (SSOT)

Defined on `NormalizedTokenCounts` in
`apps/desktop/src/main/collectors/types.ts`:

- `input` = FRESH / uncached prompt tokens.
- `cacheRead` / `cacheWrite` = separate, additive (NOT a subset of `input`).
- Grand total = `input + cacheRead + cacheWrite`.

Per-parser compliance (audited): Claude, OpenCode, Cursor, Copilot report fresh
natively and store `input` verbatim; **Codex** reports an inclusive total and
MUST subtract cached at parse time (`codex-parser.ts`, `nonCachedInput`). Copilot
was verified fresh via a fixture where `cache_read` (2000) far exceeds `input`
(600) — impossible under an inclusive total. No Gemini parser exists yet; the
contract covers future parsers.

## Resolution (what changed)

1. **Engine** (`packages/loops-api/src/genai-cost.ts`): removed
   `CACHE_ADDITIVE_PROVIDERS`; `buildUsage(counts)` (no `providerId` param) now
   ALWAYS sums `input + cacheRead + cacheWrite`. `resolveProviderId` is retained
   only for the returned `provider` field.
2. **Re-export** (`apps/desktop/src/shared/token-cost.ts`): dropped
   `CACHE_ADDITIVE_PROVIDERS`.
3. **Comments**: documented the contract on `NormalizedTokenCounts` /
   `NormalizedTokenRecord` and at each parser's token-construction site.
4. **Tests**:
   - `apps/desktop/test/collectors-parsers.test.ts`: per-parser fresh-shape
     invariant tests (existing assertions for Claude/Codex/OpenCode; new ones for
     Cursor and Copilot using `cache_read > input`).
   - `packages/loops-api/__tests__/genai-cost.test.ts` &
     `apps/desktop/test/token-cost.test.ts`: removed the
     `CACHE_ADDITIVE_PROVIDERS` tests; `buildUsage` now asserted always-additive;
     recomputed the gpt fixture costs (input now summed with cache); added a
     regression case (a Codex-shaped row with `cacheRead > input` prices without
     `compute_error`).

## Why this is safe for dashboards

Storage is unchanged (still fresh for every parser), so every total/aggregation
and cache-rate computation keeps working. Only the cost engine's reconstruction
of the genai-prices grand total changed — and only for non-anthropic providers,
which were the broken ones.
