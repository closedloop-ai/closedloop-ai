# Cost Engine Package Guidelines

`@repo/cost` is the canonical, cross-runtime token-cost engine, shared by `apps/desktop`
(synced-session costing, via the re-export shim in `apps/desktop/src/shared/token-cost.ts`)
and `packages/app` (the browser/cloud branch + transcript-turn cost projectors).

- **`genai-cost.ts` (`computeTokenCost`)** — **trust the library** (`@pydantic/genai-prices`):
  never override, clamp, assert, or rewrite a price it returns; the module's only job is to
  feed correct inputs. It must never throw — callers rely on that in hot renders and batch
  loops — and when it can't price a row it returns a typed not-priced `reason`
  (`unknown_model` | `no_match` | `compute_error` | `invalid_count`) so the UI can render
  "—" deliberately and observability can report the miss.
- **`harness-cost-parity.ts` (`computeHarnessCost`)** — the Claude-Code `/cost` parity layer
  on top, and it is **purely additive**: a caller passing none of the extras, on a model the
  library can price, must get a result byte-identical to `computeTokenCost`.
- **Corrupt counts are refused as `invalid_count` with a null cost — never coerced or clamped
  into a lying number** (ISS-4730). This covers **every** count a price is derived from, not
  just the four token counts: the harness-only `webSearchRequests` and `cacheWrite1hTokens`
  are validated against the same `isValidTokenCount` predicate that backs
  `areTokenCountsValid`, plus the structural rule that the one-hour subdivision cannot exceed
  the `cacheWriteTokens` bucket it subdivides.

## Mutation testing (opt-in)

Reading results: a *survived* mutant means no test failed when that code was changed. Not every survivor is a real gap — equivalent mutants (no observable behavior change) and intentionally-untested defensive or type-forbidden branches survive by design. Use it as a guide, not a target score.

`pnpm --filter @repo/cost mutation`, or `--mutate "src/genai-cost.ts"` to scope it to one
file; the package-local `stryker.config.json` is the config. Keep its explicit
`"plugins": ["@stryker-mutator/vitest-runner"]` line — Stryker's plugin auto-discovery does
not work under pnpm's strict `node_modules`.
