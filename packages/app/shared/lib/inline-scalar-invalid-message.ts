/**
 * ISS-9590 — what an inline scalar editor says about a draft it cannot read.
 *
 * `InlineScalarCell` requires this on its `number` variant, the only one
 * `validity.badInput` can reach, so an adapter cannot wire the champion up to
 * refuse in silence. The design system may carry no words of its own, so the
 * sentence has to come from here.
 *
 * It sits in `shared` rather than beside the custom-field rejection map because
 * two layers supply it: the `custom-fields` slice and the cross-feature preview
 * cells under `shared/components/generic-artifact-surface`. `shared` may not
 * load a slice (`packages/app/AGENTS.md`, Dependency Direction), so a value
 * both need lives in the lower layer and the slice's rejection map reads it
 * from here.
 *
 * The words are unchanged from the grid cell that shipped them. Nothing here
 * was composed, and nothing may be.
 */
export const INLINE_SCALAR_NUMBER_INVALID_MESSAGE = "Enter a valid number";
