/**
 * The focus indicator a field FRAME draws for the input inside it (ISS-11058).
 *
 * Not `CHIP_FOCUS_RING_CLASS`: that recipe is `focus-visible:` on the focused
 * element itself, and here the focused element is an inner field whose own ring
 * is suppressed so the frame reads as the field. The design system ships no
 * focus-within primitive, so the frames ISS-11058 swept share this hand-rolled
 * recipe, at the full-strength `--ring` token the contrast harness measures.
 */
export const FOCUS_WITHIN_RING_CLASS =
  "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring";
