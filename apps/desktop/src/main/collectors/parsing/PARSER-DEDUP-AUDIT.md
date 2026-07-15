# Harness parser duplication audit (FEA-2234 §4)

> Audit-first per the ticket: *"parser code is where format-specific logic
> legitimately diverges. Audit how much is genuinely duplicated before
> extracting — avoid a wrong abstraction."* This note records what was examined,
> what was extracted, and — more importantly — what was **deliberately left in
> place** and why.

## Scope & method

The five harness parsers (~5.1k LoC) were each catalogued in full:

| Parser | LoC | Token shape |
|---|---|---|
| `codex/codex-parser.ts` | 1393 | **inclusive** — subtracts cached (`nonCachedInput`) |
| `copilot/copilot-parser.ts` | 1267 | fresh (no subtraction); two parse paths (chat + CLI) |
| `claude/claude-parser.ts` | 998 | fresh (no subtraction) |
| `opencode/opencode-parser.ts` | 882 | fresh (no subtraction); batch DB store |
| `cursor/cursor-parser.ts` | 535 | fresh (no subtraction) |

For each parser we inventoried: every local helper (classified `GENERIC` /
`FORMAT-SPECIFIC` / `GLUE`), the token "fresh-shape" enforcement, message and
tool-use extraction, and `tokensByModel` / `tokenSeries` aggregation. Each
candidate was then compared across all five to separate genuine duplication
from surface similarity.

## Already shared (no action needed)

The parsers are already well-factored. Every parser consumes
`createNormalizedSession` (the FEA-2234 §1 factory) and `parser-utils.ts`, which
already centralizes: `toIso`, `safeJson`, `stringValue`, `extractErrorMessage`,
`truncateText`, `computeLineDelta`, `computeUnifiedDiffDelta`, `countDiffFiles`,
`extractRepoFromCwd`, `flattenTextValues`, `extractPrReferences`,
`extractIssueReferences`, `isSyntheticModelKey`, `collectArtifacts`,
`pushTurnDuration`. Token arithmetic primitives (`readStorageTokenCountAlias`,
`addStorageTokenCounts`, `subtractStorageTokenCounts`) live in `token-counts.ts`
and are shared. Artifact-ref extraction is shared via `artifact-ref-extractor.ts`.

## Cross-parser candidate comparison

| Candidate | claude | codex | copilot | cursor | opencode | Verdict |
|---|---|---|---|---|---|---|
| **first/last ISO timestamp min/max** | ✓ (inline) | ✓ | ✓ ×2 | ✓ | ✓ | **EXTRACTED** (4 of 5 — see below) |
| object/record type guard (`asRecord`/`asRec`/`isObject`/`isRecord`) | `{}` fallback, keeps arrays | `null` fallback, drops arrays | boolean | `{}` fallback, drops arrays | boolean | **`null`-variant extracted; `{}`/boolean kept local** — the `null`-fallback/drops-arrays guard (codex `asRec`, plus the byte-identical `asRecord`/`recordValue`/`asSyncRecord` in `db-helpers`/`subagent-scanner`/`codex-subagent-rollouts`/`session-trace`) now shares `asRecord` from `shared/type-guards.ts` (FEA-2820). The `{}`-fallback (claude, cursor) and boolean (copilot, opencode) stay local — unifying *those* would change call-site semantics (`{}` vs `null` vs boolean; array handling differs). |
| token "fresh-shape" reader | fresh, verbatim | **subtracts cached** | fresh, +reasoning→output | fresh, last-wins | fresh, +reasoning→output | **Keep local** — codex is the deliberate inclusive-total exception (documented in `types.ts`); alias lists and reasoning-folding differ per harness. A shared reader would need a per-harness alias map + a subtract-or-not flag, re-introducing the divergence as config. |
| message text flattening (`extractText`/`extractMessageText`) | content-block array | Responses-API blocks | `text/content/markdown/body/value` + parts | `content/text/message` | string/parts/`.text` | **Keep local** — each recognizes a different block vocabulary; a naive merge would pull tool-block text into message text. Partially already covered by `flattenTextValues` where a boolean/string-list suffices. |
| tool-result back-link (`attach output to a prior tool use`) | by `tool_use_id` | by `call_id`/recency | by name + output-less `findLastIndex` | positional `at(-1)` | positional `at(-1)` | **Keep local** — the *match strategy* legitimately differs (id vs name vs position). A shared helper would need a caller-supplied predicate, i.e. all the logic stays at the call site anyway. |
| JSON-cell parse (`parseJsonValue`/`parseJsonCell`) | returns `undefined` | — | — | — | returns passthrough | **Keep local** — different sentinels; overlaps `safeJson` but the fallback value is load-bearing at call sites. |
| `tokensByModel` single-key build | n/a (multi-model) | multi-model + rebase | single key | single key | single key | **Keep local** — claude/codex legitimately emit multiple model keys; the "single key" shape is not universal. |
| burst/replay dedup (`isBurstSession`, fork-replay) | — | ✓ | — | — | — | **Keep local** — codex-only anti-pattern for re-serialized rollouts. |

## Extraction landed

**`noteTimestamp(bounds, raw)` + `TimestampBounds`** in `parser-utils.ts`.

Four parsers (codex, copilot, cursor, opencode) tracked the session's
`startedAt`/`endedAt` window with **byte-identical** logic over
`acc.firstTimestamp` / `acc.lastTimestamp`:

```ts
const iso = toIso(raw);
if (!iso) return null;
if (!first || iso < first) first = iso;   // ISO 8601 sorts lexically
if (!last  || iso > last)  last  = iso;
return iso;
```

copilot carried this **twice** (once per parse path). All four route through
`toIso`, so the shared helper is a behavior-preserving drop-in. codex keeps a
one-line local wrapper because it additionally advances its own `lastTs` cursor;
the span min/max delegates to the shared helper (imported as
`foldTimestampBounds`). This removes 5 copies of the idiom and centralizes the
"ISO strings compare lexically" invariant.

**The Claude parser was deliberately NOT migrated.** Its bounds tracking uses a
local `isoTs` whose string handling differs from the shared `toIso`: `isoTs`
passes ISO strings through verbatim, whereas `toIso` re-normalizes them via
`Date` (e.g. `…00:00Z` → `…00:00.000Z`). Routing Claude through the shared helper
would silently change its stored `startedAt`/`endedAt` values — exactly the
wrong-abstraction trap this audit exists to avoid. Claude keeps its local
bounds tracking.

## Conclusion

The collection layer is already at an appropriate level of shared abstraction.
The residual cross-parser similarity is dominated by **format-coupled logic that
only looks alike** (token shape, text-block vocabularies, tool-result matching),
where a shared abstraction would have to be re-parameterized per harness — i.e.
the divergence would move into config rather than disappear. The one genuinely
format-agnostic duplication (the ISO timestamp window) has been lifted. No
further extraction is recommended without a concrete new requirement that forces
two parsers to share behavior they don't share today.
