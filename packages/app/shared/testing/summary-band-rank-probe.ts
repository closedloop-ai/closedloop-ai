// gardener-support: test and story data, not shipped
import { SUMMARY_CARD_STRETCH_CLASS } from "@repo/app/shared/components/summary-card-row";

const SUMMARY_CARD_MIN_PROPERTY_NAME = "--summary-card-min";

/**
 * What a mounted metric band actually laid out, COUNTED rather than asserted.
 *
 * ISS-11472's deliverable is "once, for every bar": one strip per surface, and
 * every card in it absorbing the band's spare width instead of pinning to
 * `--summary-card-min` and stranding the remainder as a dead gutter to the right
 * of the last card. Both halves have to be counted, because the obvious spelling
 * of each is vacuous:
 *
 * - An absence check ("no second strip") passes on a surface that rendered NO
 *   strip, so `strips` is published for an equality against 1, never probed for
 *   a duplicate.
 * - "every card stretches" over an empty list is vacuously true, so `cards` is
 *   published beside `stretchingCards` and a caller compares BOTH — the presence
 *   floor and the equality — against the same locator. That is the gap whitlockk
 *   named on #8082: the existing specs check card count, rank and floor, so
 *   removing `grow` again stayed green.
 *
 * A probe rather than an assertion helper, so it carries no test-runner import
 * and each shell keeps its own `expect` calls where a failure names that shell.
 */
export function summaryBandRankProbe(root: ParentNode): {
  readonly cards: number;
  readonly stretchingCards: number;
  readonly strips: number;
} {
  // The strip is the element that PUBLISHES the shared floor — the same handle
  // every shell's existing summary spec walks to, so this cannot select a
  // different node than they assert against.
  const strips = [...root.querySelectorAll<HTMLElement>("*")].filter(
    (node) => node.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY_NAME) !== ""
  );
  const cards = strips.flatMap((strip) => [
    ...strip.querySelectorAll<HTMLElement>('[data-slot="card"]'),
  ]);
  const stretchTokens = SUMMARY_CARD_STRETCH_CLASS.split(" ");
  return {
    cards: cards.length,
    stretchingCards: cards.filter((card) =>
      stretchTokens.every((token) => card.classList.contains(token))
    ).length,
    strips: strips.length,
  };
}
