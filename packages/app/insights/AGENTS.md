# @repo/app/insights — dashboard widgets

Renders the Insights dashboard widgets for **both** shells (`apps/app` web, `apps/desktop` renderer).

Cross-feature rules and the widget fan-out cap: `packages/app/AGENTS.md`.

This node covers only what is insights-specific.

## A widget must never present an unavailable metric as a real number

These widgets aggregate spend, duration, and counts that are routinely *not computed* for a window rather than zero. A flat series, an empty chart, or `$0.00` each read as a real measurement, so an unavailable metric rendered that way is the UI lying — carry unavailability through to the render and make it visibly distinct from a true zero.

## Aggregates must reconcile with the window and population they claim

- A date-bounded aggregate must exclude null/unknown source timestamps rather than bucketing them into the window; a documented bounded fallback timestamp is the only exception.
- Narrowing a filter must never increase an included count. When it can, the denominator changed — say so or mark the widget unavailable.
- The same entity can arrive through more than one input stream. Deduplicate on a non-nullable identity before aggregating, or the widget double-counts silently.

## Golden render fixtures

Layer-4 aggregate rendering is pinned by `__tests__/fixtures/golden-render-aggregates.json`, which is **derived** from the frozen oracle in `packages/golden-sessions/`. Never edit it to make a test pass — regenerate it under its driving ticket per `packages/golden-sessions/AGENTS.md`; a red golden render test means the aggregate changed.
