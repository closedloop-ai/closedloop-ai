# apps/prototypes — design-system prototype sandbox (:3030)

Presentational, mock-data only: no database, auth, or API. Prototypes are the reference a production build is made faithful to — never shippable code. Authoring workflow: `/prototype`, `/prototype-brief`, `/design-review`.

## Mocks must be derivable from the real source

- Name the producer for every field. If a row needs fields the real DTO does not expose, either constrain the row to the current DTO or record in `prototype.meta.ts` which API change the prototype presumes.
- Nullable upstream ⇒ show the null/unhydrated states. Those states are usually why the screen is being designed.
- Keep figures plausible. Do not apply range multipliers to cumulative totals; hand-author each window or cap the long ranges.

## Controls must drive the data, or not be interactive

A range picker or scope selector that changes only labels while children read module-level aggregates over the whole population is worse than no control — it presents an unresolved question as settled. Either filter the shared population before deriving the view models, or make the scope fixed and non-interactive.

Same for forms: carry every collected field through to the payload or do not offer the field. Generated IDs must be collision-proof — a title slug makes duplicate titles share React keys, column order, width/visibility, and filter state.

## One owner per flow

A new prototype covering a flow an existing one owns must, in the same change, mark the old one superseded in `prototype.meta.ts` and reuse what still applies. Two `ReadyForReview` prototypes for one flow is two sources of truth.

## Responsive + accessible at prototype fidelity

- Check 390px. Non-shrinking control groups clip inside `overflow-hidden` previews; fixed-width editors (`w-96`) do the same. Add a compact/wrapping state and constrain editors to the viewport.
- Blank column headers still need an accessible name — pass `ariaLabel` on any `GridTable` column whose visible label is empty (`role="columnheader"` otherwise exposes no name).

## No dead code

Unused exports read as intent. No throwaway constants or crash-test scaffolding; keep scratch state module-local.
