# apps/api/app/agent-sessions — session ingest + read

The cloud half of the desktop sync contract. The producer is `apps/desktop/src/main/agent-sync/` and friends; treat every payload shape here as version-skewed against installed desktop builds. App-wide route/service rules: `apps/api/AGENTS.md`.

> **Session status: the root `AGENTS.md` "Session State" section is canonical** — defer to it on any disagreement. **Which spelling folds onto which value is `normalizeSessionStatus` (`packages/api/src/types/session-status.ts`); read it, never a paragraph about it.** ISS-5592 deleted the alias map it used to consult: there are no aliases left, so the three lifecycle values are the whole vocabulary a producer can land on. ISS-6581 deleted the transcription that used to live here after it drifted: prose restating a short lookup table is how this axis has repeatedly published a fold the code had already stopped performing.
>
> What is true here and NOT derivable from that table:
>
> - **Writes ACCEPT more than the three lifecycle values** — narrowing what is accepted is a breaking change. Accept-and-fold is the pattern; accept-and-store was the defect.
> - **Two write paths fold, and both preserve the `awaitingInputSince` anchor**: the main ingest write in `service/upsert-session-slice.ts` (ISS-5981, folding every incoming status and every terminal-wins persisted one) and `service/session-reopen.ts` (ISS-5974). The anchor matters because it is the awaiting-input signal's only durable form once the word is folded away.
> - **No NEW row can carry a non-lifecycle status**, because that ingest fold returns `SessionStatus`. Rows written before ISS-5981 were not backfilled and still can, which is why reads stay tolerant.
> - **ONE fold metric**, `service/status-fold-telemetry.ts`, batch-aggregated. ISS-5592 deleted `RetiredStatusFolded` (ISS-4654's gate-3 drain signal) along with the fold it measured, so a retired spelling now counts under the same counter as any other unmodelled one and producer skew stays visible in one place rather than two.
> - **Reads emit display-only values by contract.** `projectDisplayedSessionStatus` (`service/session-status-projection.ts`) derives them per read (ISS-4997/ISS-4998); collapsing any of them breaks the filter-input contract.
> - **The awaiting-input branch runs AHEAD of that derivation**, and excludes only spellings the fold recognises as terminal — so an UNRECOGNISED status carrying the anchor projects `waiting`, not `unknown` (wongk, #5075). A finished run can therefore read as awaiting input. Deliberate: closing it means recognising the spellings ISS-5592 removed.
> - **`AgentSessionState`** (derived in `service/projections.ts`) is a **different axis**. Keep them separate.
>
> Consolidation: ISS-5592. Why the retired spellings went, and the evidence behind it: `docs/session-status-vocabulary.md`.

## Watermarks

- **Separate the attempt watermark from the landed-data watermark.** On a partial multi-session batch, sessions committed before the failure are durable but invisible to the stall detector if only the attempt watermark is stamped. Stamp what actually landed.
- A repair path that fixes a poisoned watermark must emit its telemetry metric, and the test must assert the emission — otherwise a refactor silently turns the repair into the "silently coerced" path the root guidance forbids.
- Multi-session payloads remain accepted for version skew even after the desktop moves to one session per request. Keep the comments describing the transaction/rollback semantics accurate to what the code now does.

## Snapshot vs. append

Replacement must be keyed to the lifecycle that actually produced the data, not a proxy revision. A classifier backfill can replace a local tiling and bump `updated_at` without changing the data revision; if replacement is derived from the data revision, the cloud treats a complete snapshot as an append, so stale spans survive and same-key rows keep stale phase/version data. Chunked same-revision snapshots are worse — chunk 0 never opens a pending sequence, so later slices arrive foreign while the desktop still acknowledges them.

## Chunking

Validate every ceiling the receiver enforces, not just the one the paginator bounds. A gzipped slice can satisfy byte limits and still exceed a **row-count** limit (`MAX_SYNCED_ACTIVITY_SEGMENTS`), so the API rejects the part before persistence and re-preparation reproduces the same invalid part until the session dead-letters. Bound by rows and bytes.

## Identity before authorization

Do not authorize a mutation on a caller-supplied source identifier before validating and persisting the relationship it claims. Derive the label/tag source from the committed relationship, and cover the invalid-source and failed-link cases asserting no external mutation occurred.

## Fan-out identity

When folding usage from multiple relationship paths (FK link vs. kind/key match), verify the two identities agree before preferring one. A child carrying identity for pack B but FK-linked to pack A leaves list and detail disagreeing. Pin the cross-pack case with list *and* detail coverage.
