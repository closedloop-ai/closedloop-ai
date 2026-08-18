# Layer 2 golden snapshots (FEA-2647)

One JSON file per non-null golden dossier (`packages/golden-sessions/<sessionId>/`),
capturing the FULL per-store row state after importing that dossier's frozen
`normalized.json` through the production importer (`write-core.ts`) into a fresh
temp SQLite store. Consumed by `apps/desktop/test/golden-layer2.{utc,chicago}.test.ts`
via `test/golden/golden-layer2.ts`.

## What these are — and are not

These are **regression guards, not ground truth** (PRD-516). The signed
oracle lives in each dossier's `expectations.yaml`; the fact-level assertions in
the Layer 2 runner check the store against that oracle and against the input.
Snapshots exist to catch drift the dossier keys don't cover: if the importer's
output for identical input changes in ANY captured column, the deep-equal fails
and points at the table.

## When regeneration is legitimate

A snapshot diff means the write path's output changed for identical input:
either a bug (fix the code) or a deliberate semantic change under a driving
ticket. These are derived regression guards, not oracle files — the "Trust
classes" section of `packages/golden-sessions/AGENTS.md` says when regenerating
them (procedure below) is legitimate.

## Regeneration procedure

```
cd apps/desktop
GOLDEN_L2_WRITE_SNAPSHOTS=1 pnpm exec tsx --test --test-timeout=600000 test/golden-layer2.utc.test.ts
```

Write mode is permitted from the UTC suite ONLY (the runner rejects it under any
other TZ — the two TZ test files run as concurrent child processes and must
never race the same file). After regenerating, run BOTH TZ suites clean and
re-run the UTC suite a second time to re-prove cross-run determinism.

## Determinism contract

- Per-dossier injected clock `NOW_d = max(all ISO timestamps in the input) + 1h`
  — a pure function of the input, so adding a new dossier never invalidates
  existing snapshots.
- `fileModifiedAt` nulled on the input (capture-machine mtime, not a fact).
- Rows sorted by their serialized form; BigInt → Number; TEXT values > 200 chars
  stored as `{ sha256, chars }` (drift still detected byte-exactly).
- Unix and Windows user-home prefixes are canonicalized to `<HOME>` before
  storage or hashing so snapshots do not expose or depend on the capture host.
- `pull_requests.created_at/observed_at` are stored without masks. Creation uses
  the per-dossier injected clock, while observation comes from the newest valid
  external session timestamp (falling back to that same clock on first create).
  Re-import and rebuild preserve these values unless newer evidence is supplied.
- Pricing-derived cost columns are date-aware lookups over frozen session
  timestamps; a genai-prices HISTORICAL-rate backfill would drift them →
  recapture (see `packages/golden-sessions/AGENTS.md`).

## Known truth limitations

The current dossiers deliberately defer signed pricing truth, so their
`expectations.yaml` cost values are not a usable oracle for Layer 2. The runner
instead proves cross-store cost conservation. FEA-3232 pins the observed Codex
case where `token_events` costs do not conserve against `token_usage`; this is
an explicit expected failure, not masked snapshot drift.

## Provenance

- Generated: 2026-07-15, FEA-2647 build (branch `feat/fea-2647`), from corpus
  state at PR #2760/#2815-era main (22 dossiers, 21 non-null).
- Generated under TZ=UTC; verified byte-identical under a second UTC run and an
  America/Chicago run.
- Verification: aggregate fact assertions passed against every dossier's
  `expectations.yaml` before capture (expected-fails ticket-keyed in
  `golden-layer2-divergences.ts`); each snapshot additionally spot-checked by a
  per-session verification agent during the build. Sign-off was recorded in
  that corpus PR's review (the FEA-2647 build predates the current
  protocol in `packages/golden-sessions/AGENTS.md`).
