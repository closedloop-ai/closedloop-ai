/**
 * The `aria-invalid` treatment every form primitive paints (ISS-9063).
 *
 * ## Why this file exists
 *
 * The same three utilities were written out verbatim in eight primitives —
 * `button`, `badge`, `checkbox`, `input`, `radio-group`, `select`, `textarea`,
 * `toggle`. That is one behaviour with eight owners: the focused-invalid ring
 * was below WCAG 1.4.11's 3:1 in all eight, and fixing it meant finding all
 * eight. Declaring it once means the next change to the invalid state reaches
 * every primitive, and the contrast sweep has a single string to measure
 * instead of a transcription that can drift away from what ships.
 *
 * ## Why the focus override is spelled twice
 *
 * `--ring` is the focus indicator, but `aria-invalid:ring-destructive/20` is a
 * plain `[aria-invalid="true"]` rule, so it ties with `focus-visible:ring-ring`
 * on specificity and the cascade decides — a focused invalid field paints the
 * 20% red halo (1.32:1 on background) instead of a focus indicator. The
 * compound `aria-invalid:focus-visible:` selector outranks both rules rather
 * than racing them, and it keeps the error hue: full-strength `--destructive`
 * measures 3.92:1 on light background and card, 4.06:1 / 3.88:1 in dark. The
 * `dark:` spelling carries the SAME colour and exists only to outrank
 * `dark:aria-invalid:ring-destructive/40`, which `@custom-variant dark
 * (&:is(.dark *))` gives the same specificity as the unprefixed compound.
 *
 * The unfocused `/20` and `/40` halos are deliberately unchanged: the state
 * indicator there is `aria-invalid:border-destructive` at full strength, and
 * the halo behind it is decoration, not the focus indicator 1.4.11 measures.
 */
export const INVALID_STATE_UTILITIES =
  "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive dark:aria-invalid:focus-visible:ring-destructive";
