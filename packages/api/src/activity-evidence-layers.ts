/**
 * ISS-4791 — the SINGLE source of truth for the evidence-layer names carried by
 * `SyncedActivitySegmentRow.evidenceLayers` (`@repo/api/src/types/agent-session`).
 *
 * It lives in `@repo/api` because the literal describes a field on a wire type
 * `@repo/api` already owns, and because its consumers span layers `@repo/lib`
 * cannot reach up into:
 *   - the read-time aggregation's inferred-vs-declared discriminator
 *     (`@repo/lib/sessions/activity-segment-aggregation`),
 *   - the renderer's band-folding tests (`@repo/app`), and
 *   - the Playwright session-detail fixture (`e2e/helpers`), which builds a raw
 *     tiling for the composed detail view.
 *
 * That last consumer is why it is here rather than in `@repo/lib`: the e2e suite
 * resolves `@repo/*` through the ROOT tsconfig `paths`, but a module it pulls in
 * from inside `packages/lib` resolves against `packages/lib/tsconfig.json`, which
 * has no `paths` — so `packages/lib`'s own extensionless `@repo/api/src/...`
 * imports fall back to Node resolution and cannot be found. Keeping the literal
 * on a zero-dependency `@repo/api` module lets every surface, e2e included,
 * import the same symbol instead of re-spelling the string.
 *
 * Deliberately zero-dependency, for the same reason as its sibling
 * `activity-phase-labels.ts`: it is reachable from `"use client"` components on
 * both the web and desktop surfaces, so it must not drag parsers or validators
 * into a client bundle that only wants a string.
 */

/**
 * Evidence-layer name the desktop classifier writes when a phase boundary was
 * declared (ground truth) rather than structurally inferred (FEA-2269). Its
 * presence on a row is the inferred-vs-declared discriminator the read-time
 * aggregation folds into `ActivitySegment.source`.
 *
 * The classifier also writes a `structural` layer, but no read-side consumer
 * discriminates on it — a row is treated as inferred whenever this layer is
 * absent — so only the layer that carries meaning downstream is pinned here.
 */
export const DECLARED_EVIDENCE_LAYER = "declared";
