import {
  CommentAnchorPlacementState,
  type CommentAnchorPosition,
  type CommentAnchorQuote,
} from "@repo/realtime-contract/doc-sync-internal";
import type { FlatText } from "./comment-anchor-flatten";

export type TextSelector = {
  quote: CommentAnchorQuote;
  position?: CommentAnchorPosition;
};

/** Where a selector landed; a selector that lands nowhere resolves to `null` (orphaned). */
export type ResolvedTextSelector = {
  start: number;
  end: number;
  state:
    | typeof CommentAnchorPlacementState.Anchored
    | typeof CommentAnchorPlacementState.Moved;
};

/**
 * PLN-2187 T-3.1: the best occurrence of `quote.exact` in `flat.text`.
 * Score = prefix match length + suffix match length
 * - |start - position.start| / 1000; ties go to the lowest start.
 * ANCHORED only when the prefix, the suffix and the position all match
 * exactly, so a selector with no position is at best MOVED.
 */
export function resolveTextSelector(
  flat: Pick<FlatText, "text">,
  selector: TextSelector
): ResolvedTextSelector | null {
  const { text } = flat;
  const { exact } = selector.quote;
  if (exact.length === 0) {
    return null;
  }
  let best: ScoredCandidate | null = null;
  for (
    let start = text.indexOf(exact);
    start !== -1;
    start = text.indexOf(exact, start + 1)
  ) {
    const candidate = scoreCandidate(text, start, selector);
    if (best === null || candidate.score > best.score) {
      best = candidate;
    }
  }
  if (best === null) {
    return null;
  }
  return {
    start: best.start,
    end: best.end,
    state: best.isExact
      ? CommentAnchorPlacementState.Anchored
      : CommentAnchorPlacementState.Moved,
  };
}

type ScoredCandidate = {
  start: number;
  end: number;
  score: number;
  isExact: boolean;
};

function scoreCandidate(
  text: string,
  start: number,
  { quote, position }: TextSelector
): ScoredCandidate {
  const end = start + quote.exact.length;
  const prefixMatch = matchBackward(text, start, quote.prefix);
  const suffixMatch = matchForward(text, end, quote.suffix);
  const distance =
    position === undefined ? 0 : Math.abs(start - position.start);
  return {
    start,
    end,
    score: prefixMatch + suffixMatch - distance / 1000,
    isExact:
      prefixMatch === quote.prefix.length &&
      suffixMatch === quote.suffix.length &&
      position !== undefined &&
      position.start === start &&
      position.end === end,
  };
}

/** How many trailing characters of `prefix` equal the text just before `start`. */
function matchBackward(text: string, start: number, prefix: string): number {
  let matched = 0;
  while (
    matched < prefix.length &&
    matched < start &&
    prefix.at(-1 - matched) === text[start - 1 - matched]
  ) {
    matched++;
  }
  return matched;
}

/** How many leading characters of `suffix` equal the text from `end` on. */
function matchForward(text: string, end: number, suffix: string): number {
  let matched = 0;
  while (
    matched < suffix.length &&
    end + matched < text.length &&
    suffix[matched] === text[end + matched]
  ) {
    matched++;
  }
  return matched;
}
