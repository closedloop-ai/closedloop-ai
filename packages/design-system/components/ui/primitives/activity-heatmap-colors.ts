/**
 * The heatmap's ramp colours, in a runtime-free module so a consumer can reason
 * about them without importing the component (ISS-5335).
 *
 * The level-0 value is the reason this file exists. `var(--muted)` is the "we
 * observed nothing here" cell — an intentionally near-invisible surface tint, so
 * an empty week reads as background rather than as data. That makes it the one
 * token on the Insights dashboard that already MEANS "empty", which in turn
 * makes it the wrong token for any chart series that means the opposite. The
 * spend-by-outcome map painted a real bucket of money with it and the slice
 * vanished; its test now asserts against this export directly, so if the heatmap
 * ever re-tunes its empty cell the guard follows instead of drifting.
 */
export const ACTIVITY_HEATMAP_EMPTY_LEVEL_COLOR = "var(--muted)";

/**
 * Alpha stops for the ACTIVE ramp levels (1…5). Level 0 is not on this ramp; it
 * is {@link ACTIVITY_HEATMAP_EMPTY_LEVEL_COLOR}.
 */
export const ACTIVITY_HEATMAP_RAMP_ALPHA = [0.34, 0.5, 0.66, 0.82, 1] as const;
