/**
 * ISS-8734: the next offset token an offset-cursor list response may hand back,
 * or `null` when it may not.
 *
 * `nextCursor` encodes an offset the SERVER mints and the client replays, and
 * these list schemas now bound `cursor` by the same ceiling as `offset`.
 * Deriving the token from the population alone would mint one past that ceiling
 * and then answer 400 to a token we issued — the API contradicting itself,
 * which is a worse contract than any bound. Withholding it stops the walk AT
 * the ceiling instead.
 *
 * That is not a silent truncation: `total` still reports the whole population,
 * so a response carrying more rows than it returned and no cursor says "there
 * are more, and this pagination cannot reach them" rather than claiming the
 * population is exhausted.
 */
export function nextOffsetCursor(
  nextOffset: number,
  total: number,
  maxOffset: number
): string | null {
  if (nextOffset >= total || nextOffset > maxOffset) {
    return null;
  }
  return String(nextOffset);
}
