/**
 * ISS-5362 (#4514 review): the spend-by-outcome ring's identity channels, split
 * out of `tile-catalog.ts`.
 *
 * These four constants answer one question — how a reader tells the four
 * outcome buckets apart — and they answer it in prose as much as in values:
 * which hues the semantics pin, why hue alone fails under dichromacy, which
 * texture each bucket gets, and which bucket cannot carry the default mark
 * colour. That is a different responsibility from enumerating dashboard tiles,
 * and `tile-catalog.ts` had grown to the 1,000-line ceiling carrying both.
 */

import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import { DonutSliceTexture } from "@repo/design-system/components/ui/donut-slice-textures";

/**
 * Semantic colours for the {@link SpendOutcome} split (ISS-4463).
 *
 * Outcome is a semantic dimension, not a categorical one: the buckets mean good,
 * bad, in-progress and don't-know. Left on the generic index palette the failure
 * bucket drew `--chart-2` and the never-recorded bucket drew `--chart-3` — colour
 * carrying no meaning, and the one meaning it accidentally suggested (green for
 * missing data) was backwards. It also collided with "Spend by model" one tile
 * over, whose top bar starts at the same `--chart-1`, inviting the eye to connect
 * two unrelated things.
 *
 * So: destructive for errored, a weakened neutral for not-recorded, a neutral
 * accent for still-running, and a single chart token for ended-clean. All are
 * existing theme tokens, so both light and dark themes are handled by the token
 * layer.
 *
 * ISS-5335: the not-recorded bucket used to be `var(--muted)` (1.10:1 light /
 * 1.12:1 dark) — a SURFACE token at roughly the card's own background value, so
 * the slice read as a gap in the ring rather than as a category. A first pass
 * weakened it to `color-mix(… --muted-foreground 45% …)`, which lifted it only
 * to 2.04:1 / 2.61:1, still under the floor. It is now the plain
 * `--muted-foreground` (6.73:1 / 7.32:1), which the family is free to carry
 * because still-running moved to `--info`, leaving exactly one grey in the map.
 *
 * Note what that gives up, honestly: at full strength this is the
 * HIGHEST-contrast slice, not the quietest, so the "no status to report" bucket
 * no longer recedes by weight. It is set apart by CHROMA instead — the one
 * achromatic slice among three saturated ones. That distinction is load-bearing
 * for {@link SPEND_OUTCOME_TEXTURE_MARK_COLORS} below, which is sized to a slice
 * that is dark, not faint.
 *
 * ACCEPTED COLLISION, ISS-5335 (review). Still-running is `--info`
 * (L 0.6 / C 0.15 / h 250 in light), and `--chart-1` is L 0.554 / C 0.214 /
 * h 266.2 — 16 degrees apart in hue and 1.28:1 against each other, so blue does
 * sit back in that neighbourhood, on a tile adjacent to "Cost by model". This is
 * accepted rather than avoided, and the paragraph above is scoped to say
 * "by position" for that reason.
 *
 * The whole token space was measured before accepting it. Against `--card` in
 * LIGHT — the binding theme; everything clears in dark — only these clear the
 * 3:1 floor: `--info` 3.82, `--success` 3.19, `--destructive` 3.92, `--chart-1`
 * 4.87, `--chart-6` 3.91, `--chart-7` 3.33, `--chart-8` 5.22, `--primary` 5.47.
 * `--success` and `--destructive` already mean something IN THIS MAP;
 * `--primary` fails dark (2.98) and is `--chart-1`'s hue anyway; `--chart-6` is
 * 1.00:1 against `--destructive` (indistinguishable from the errored bucket);
 * `--chart-8` is 1.07:1 against `--chart-1`, a WORSE collision than `--info`;
 * `--chart-7` is 1.46:1 against `--chart-1` and 1.18:1 against `--destructive`,
 * so it trades this collision for one with the failure bucket. There is no token
 * that clears the floor and avoids every neighbour.
 */
export const SPEND_OUTCOME_COLORS: Readonly<Record<string, string>> = {
  [SpendOutcome.Clean]: "var(--success)",
  [SpendOutcome.Errored]: "var(--destructive)",
  [SpendOutcome.Running]: "var(--info)",
  [SpendOutcome.Unknown]: "var(--muted-foreground)",
};

/**
 * ISS-5362: the REDUNDANT, non-colour channel for the spend-by-outcome ring.
 *
 * `SPEND_OUTCOME_COLORS` above is a SEMANTIC palette — good, bad, in-progress,
 * don't-know — and semantics pin it to hues that a red/green colour-vision
 * deficiency collapses. Simulating protanopia and deuteranopia over the real
 * theme tokens, ALL SIX pairs of these four buckets land between 1.02:1 and
 * 2.37:1: every pair below the WCAG 1.4.11 3:1 non-text floor, in both themes.
 * A reader with CVD therefore cannot tell WHICH arc is which, no matter how the
 * ring is ordered — there are only three distinct rings of four slices, and the
 * best still leaves a 1.18:1 (light) / 1.42:1 (dark) worst adjacent pair.
 *
 * So identity gets a second channel that no colour vision removes, and the
 * assignment follows two rules rather than taste.
 *
 * FIRST, `Clean` stays flat. It is usually the dominant slice, a fully-hatched
 * ring is noise, and being the only flat slice is itself an identity — every
 * weakest colour pair is a pair against `Clean`, so every one of them is
 * flat-against-textured, the most legible contrast this channel has.
 *
 * SECOND, `Running` and `Unknown` take the two MOST distinct textures — a dot
 * field against an orthogonal grid. Since EVERY pair fails the floor under CVD,
 * no pair is "the worst" to spend the best separation on; what decides it is
 * that these two are the pair a reader is most likely to have to tell apart on
 * a real ring, because "still running" and "never recorded" are the two buckets
 * that mean the outcome is not yet known and are read against each other.
 * `Errored`, whose red sits furthest from both, keeps the middling `Diagonal`.
 *
 * Within that pair, `Unknown` takes the LIGHTER texture, and after ISS-5335 that
 * is the straightforward choice rather than the delicate one it used to be.
 * Marks are a lightness lever, not a neutral one (see
 * `donut-slice-textures.tsx`), and `Unknown` is now the DARKEST, highest-contrast
 * slice on the ring — 6.73:1 against the card — so it has the most ink to give
 * up. Card-coloured marks punched into it read as gaps at full strength, which
 * is exactly what the lighter texture wants.
 */
export const SPEND_OUTCOME_TEXTURES: Readonly<
  Record<SpendOutcome, DonutSliceTexture>
> = {
  [SpendOutcome.Clean]: DonutSliceTexture.Solid,
  [SpendOutcome.Errored]: DonutSliceTexture.Diagonal,
  [SpendOutcome.Running]: DonutSliceTexture.Crosshatch,
  [SpendOutcome.Unknown]: DonutSliceTexture.Dots,
};

/**
 * ISS-5362 (#4514 review): the one contrast this whole channel lives on.
 *
 * A texture is only a channel if its MARKS are visible against the slice they
 * are drawn on. Marks default to the card token, which works while the slice has
 * ink to give up. Measured over the real tokens, every TEXTURED bucket clears
 * the WCAG 1.4.11 3:1 non-text floor on that default, in both themes: `Errored`
 * 3.92:1 light / 3.90:1 dark, `Running` 3.82:1 / 3.26:1, `Unknown` 6.73:1 /
 * 7.32:1. `Clean` never needs a mark colour at all — it is the deliberately-flat
 * slice. So this map is EMPTY, and that is the finding, not an omission.
 *
 * It was not always. Before ISS-5335 the not-recorded bucket was
 * `muted-foreground` at 45% — 2.04:1 / 2.61:1 against the card BY DESIGN — so
 * card-coloured marks on it were marks nobody could see, and it carried a
 * `--foreground` override to draw its marks DARKER than the slice instead.
 * ISS-5335 held that bucket at FULL `--muted-foreground`, which made it the
 * darkest, highest-contrast slice on the ring rather than the faintest. The
 * override did not merely become unnecessary at that point, it INVERTED: against
 * the full-strength slice `--foreground` measures 2.42:1 light / 1.85:1 dark,
 * failing the very floor it was added to clear, while the default card mark
 * measures 6.73:1 / 7.32:1. Keeping it would have shipped the one bucket this
 * channel most exists for with marks below the floor in both themes.
 *
 * The mechanism stays wired rather than deleted — `tile-catalog.ts` still passes
 * this map through to `DonutChart` — because the rule that governs it is
 * asserted, not assumed: `spend-outcome-texture-contrast.test.ts` holds every
 * bucket to the floor on whatever mark it actually gets, and requires an
 * override for any bucket that cannot carry the default. A future palette change
 * that re-weakens a slice therefore fails that test until the override lands on
 * the right bucket, which is how this entry is meant to come back if it ever
 * needs to.
 */
export const SPEND_OUTCOME_TEXTURE_MARK_COLORS: Readonly<
  Partial<Record<SpendOutcome, string>>
> = {};

/**
 * The MEASURED-zero message for the spend-by-outcome tiles: the query ran over a
 * real period and found no spend at all. Distinct from the generic empty state,
 * which means the field was absent (a peer that does not compute this chart) —
 * "you spent nothing" and "we have nothing to show you" are different facts.
 */
export const SPEND_OUTCOME_ZERO_MESSAGE = "No AI spend in this period";
