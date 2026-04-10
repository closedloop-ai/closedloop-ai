export type RawComment = {
  id: string;
  start: number;
  end: number;
  body?: string;
  quote?: string;
  prefix?: string;
  suffix?: string;
};

export type HydratedComment = RawComment & {
  quote: string;
  prefix: string;
  suffix: string;
};

export type ReanchorStatus = "resolved" | "removed" | "ambiguous";

export type ReanchoredComment = {
  id: string;
  body?: string;
  status: ReanchorStatus;
  start?: number;
  end?: number;
  confidence: number;
  reason: string;
  quote: string;
  prefix: string;
  suffix: string;
};

export type ReanchorOptions = {
  contextChars?: number;
  seedLength?: number;
  maxCandidates?: number;
  maxSeedOccurrences?: number;
  minConfidence?: number;
  ambiguityMargin?: number;
  windowSlack?: number;
};

const DEFAULTS: Required<ReanchorOptions> = {
  contextChars: 32,
  seedLength: 8,
  maxCandidates: 48,
  maxSeedOccurrences: 20,
  minConfidence: 0.54,
  ambiguityMargin: 0.08,
  windowSlack: 24,
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function uniqueSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

export function hydrateComment(
  oldText: string,
  comment: RawComment,
  options: ReanchorOptions = {}
): HydratedComment {
  const cfg = { ...DEFAULTS, ...options };
  const start = clamp(comment.start, 0, oldText.length);
  const end = clamp(comment.end, start, oldText.length);
  const quote = comment.quote ?? oldText.slice(start, end);
  const prefix =
    comment.prefix ??
    oldText.slice(Math.max(0, start - cfg.contextChars), start);
  const suffix =
    comment.suffix ??
    oldText.slice(end, Math.min(oldText.length, end + cfg.contextChars));
  return {
    ...comment,
    start,
    end,
    quote,
    prefix,
    suffix,
  };
}

export function hydrateComments(
  oldText: string,
  comments: RawComment[],
  options: ReanchorOptions = {}
): HydratedComment[] {
  return comments.map((comment) => hydrateComment(oldText, comment, options));
}

function findAllOccurrences(
  haystack: string,
  needle: string,
  limit = Number.POSITIVE_INFINITY
): number[] {
  if (!needle) {
    return [];
  }
  const out: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) {
      break;
    }
    out.push(idx);
    if (out.length >= limit) {
      break;
    }
    from = idx + 1;
  }
  return out;
}

function commonSuffixFraction(expected: string, actual: string): number {
  if (expected.length === 0) {
    return 1;
  }
  let i = 0;
  const max = Math.min(expected.length, actual.length);
  while (
    i < max &&
    expected.charCodeAt(expected.length - 1 - i) ===
      actual.charCodeAt(actual.length - 1 - i)
  ) {
    i += 1;
  }
  return i / expected.length;
}

function commonPrefixFraction(expected: string, actual: string): number {
  if (expected.length === 0) {
    return 1;
  }
  let i = 0;
  const max = Math.min(expected.length, actual.length);
  while (i < max && expected.charCodeAt(i) === actual.charCodeAt(i)) {
    i += 1;
  }
  return i / expected.length;
}

function lcsSimilarity(a: string, b: string): number {
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return 0;
  }
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n] / Math.max(m, n, 1);
}

function prefixContextSimilarity(expected: string, actual: string): number {
  return Math.max(
    commonSuffixFraction(expected, actual),
    lcsSimilarity(expected, actual)
  );
}

function suffixContextSimilarity(expected: string, actual: string): number {
  return Math.max(
    commonPrefixFraction(expected, actual),
    lcsSimilarity(expected, actual)
  );
}

const LEADING_WHITESPACE_RE = /^\s/;
const TRAILING_WHITESPACE_RE = /\s$/;
const WHITESPACE_CHAR_RE = /\s/;

function trimResolvedWhitespace(
  originalQuote: string,
  newText: string,
  startPos: number,
  endPos: number
): [number, number] {
  let s = startPos;
  let e = endPos;
  if (!LEADING_WHITESPACE_RE.test(originalQuote)) {
    while (s < e && WHITESPACE_CHAR_RE.test(newText[s]!)) {
      s += 1;
    }
  }
  if (!TRAILING_WHITESPACE_RE.test(originalQuote)) {
    while (e > s && WHITESPACE_CHAR_RE.test(newText[e - 1]!)) {
      e -= 1;
    }
  }
  return [s, e];
}

const WORD_TOKEN_RE = /[A-Za-z0-9_]+/g;

function tokenizeWithOffsets(
  text: string
): Array<{ token: string; index: number }> {
  const out: Array<{ token: string; index: number }> = [];
  const re = new RegExp(WORD_TOKEN_RE.source, WORD_TOKEN_RE.flags);
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    out.push({ token: m[0], index: m.index });
    m = re.exec(text);
  }
  return out;
}

function buildSeeds(
  anchor: HydratedComment,
  options: Required<ReanchorOptions>
) {
  const oldWindow = anchor.prefix + anchor.quote + anchor.suffix;
  const quoteStart = anchor.prefix.length;
  const seeds: Array<{ text: string; oldIndex: number; weight: number }> = [];
  const seedLength = options.seedLength;

  const add = (text: string, oldIndex: number, weight: number) => {
    if (!text) {
      return;
    }
    if (text.trim().length < 3) {
      return;
    }
    seeds.push({ text, oldIndex, weight });
  };

  if (anchor.quote.length > 0) {
    add(anchor.quote, quoteStart, 6);
    if (anchor.quote.length > seedLength) {
      add(anchor.quote.slice(0, seedLength), quoteStart, 5);
      add(
        anchor.quote.slice(-seedLength),
        quoteStart + anchor.quote.length - seedLength,
        5
      );
      const mid = Math.floor((anchor.quote.length - seedLength) / 2);
      if (mid > 0) {
        add(anchor.quote.slice(mid, mid + seedLength), quoteStart + mid, 4);
      }
    }
  }

  const quoteTokens = tokenizeWithOffsets(anchor.quote)
    .sort((a, b) => b.token.length - a.token.length)
    .slice(0, 4);
  for (const { token, index } of quoteTokens) {
    add(token, quoteStart + index, 4 + Math.min(token.length, 12) / 12);
  }

  const prefixTokens = tokenizeWithOffsets(anchor.prefix)
    .sort((a, b) => b.token.length - a.token.length)
    .slice(0, 2);
  for (const { token, index } of prefixTokens) {
    add(token, index, 2 + Math.min(token.length, 12) / 12);
  }

  const suffixTokens = tokenizeWithOffsets(anchor.suffix)
    .sort((a, b) => b.token.length - a.token.length)
    .slice(0, 2);
  for (const { token, index } of suffixTokens) {
    add(
      token,
      quoteStart + anchor.quote.length + index,
      2 + Math.min(token.length, 12) / 12
    );
  }

  const deduped = new Map<
    string,
    { text: string; oldIndex: number; weight: number }
  >();
  for (const seed of seeds) {
    const key = `${seed.text}@@${seed.oldIndex}`;
    if (!deduped.has(key)) {
      deduped.set(key, seed);
    }
  }
  return {
    oldWindow,
    quoteStart,
    quoteEnd: quoteStart + anchor.quote.length,
    seeds: [...deduped.values()],
  };
}

type AlignmentStats = {
  exactMatches: number;
  edits: number;
  quoteExactMatches: number;
  quoteEdits: number;
  contextExactMatches: number;
  contextEdits: number;
};

type SemiGlobalAlignment = {
  score: number;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  leftBoundary: number[];
  rightBoundary: number[];
  stats: AlignmentStats;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: semi-global alignment algorithm is inherently complex
function semiglobalAlign(
  oldSeq: string,
  newSeq: string,
  quoteStart: number,
  quoteEnd: number
): SemiGlobalAlignment {
  const m = oldSeq.length;
  const n = newSeq.length;
  const matchScore = 2;
  const mismatchPenalty = -1;
  const gapPenalty = -1;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  const bt: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i += 1) {
    dp[i][0] = dp[i - 1][0] + gapPenalty;
    bt[i][0] = 2;
  }
  for (let j = 1; j <= n; j += 1) {
    dp[0][j] = 0;
    bt[0][j] = 1;
  }

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const diag =
        dp[i - 1][j - 1] +
        (oldSeq.charCodeAt(i - 1) === newSeq.charCodeAt(j - 1)
          ? matchScore
          : mismatchPenalty);
      const left = dp[i][j - 1] + gapPenalty;
      const up = dp[i - 1][j] + gapPenalty;
      let best = diag;
      let move = 0;
      if (left > best) {
        best = left;
        move = 1;
      }
      if (up > best) {
        best = up;
        move = 2;
      }
      dp[i][j] = best;
      bt[i][j] = move;
    }
  }

  let endJ = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let j = 0; j <= n; j += 1) {
    if (dp[m][j] > bestScore) {
      bestScore = dp[m][j];
      endJ = j;
    }
  }

  const ops: number[] = [];
  let i = m;
  let j = endJ;
  while (i > 0) {
    const move = bt[i][j];
    ops.push(move);
    if (move === 0) {
      i -= 1;
      j -= 1;
    } else if (move === 1) {
      j -= 1;
    } else {
      i -= 1;
    }
  }
  const startJ = j;
  ops.reverse();

  const leftBoundary = new Array(m + 1).fill(Number.POSITIVE_INFINITY);
  const rightBoundary = new Array(m + 1).fill(Number.NEGATIVE_INFINITY);
  const stats: AlignmentStats = {
    exactMatches: 0,
    edits: 0,
    quoteExactMatches: 0,
    quoteEdits: 0,
    contextExactMatches: 0,
    contextEdits: 0,
  };

  const touchBoundary = (oldPos: number, newPos: number) => {
    if (newPos < leftBoundary[oldPos]) {
      leftBoundary[oldPos] = newPos;
    }
    if (newPos > rightBoundary[oldPos]) {
      rightBoundary[oldPos] = newPos;
    }
  };

  let oldPos = 0;
  let newPos = startJ;
  touchBoundary(oldPos, newPos);

  for (const move of ops) {
    const inQuote = oldPos >= quoteStart && oldPos < quoteEnd;
    if (move === 0) {
      const match = oldSeq.charCodeAt(oldPos) === newSeq.charCodeAt(newPos);
      if (match) {
        stats.exactMatches += 1;
        if (inQuote) {
          stats.quoteExactMatches += 1;
        } else {
          stats.contextExactMatches += 1;
        }
      } else {
        stats.edits += 1;
        if (inQuote) {
          stats.quoteEdits += 1;
        } else {
          stats.contextEdits += 1;
        }
      }
      oldPos += 1;
      newPos += 1;
      touchBoundary(oldPos, newPos);
    } else if (move === 1) {
      stats.edits += 1;
      if (oldPos >= quoteStart && oldPos <= quoteEnd) {
        stats.quoteEdits += 1;
      } else {
        stats.contextEdits += 1;
      }
      newPos += 1;
      touchBoundary(oldPos, newPos);
    } else {
      stats.edits += 1;
      if (inQuote) {
        stats.quoteEdits += 1;
      } else {
        stats.contextEdits += 1;
      }
      oldPos += 1;
      touchBoundary(oldPos, newPos);
    }
  }

  for (let k = 0; k <= m; k += 1) {
    if (!Number.isFinite(leftBoundary[k])) {
      leftBoundary[k] = startJ;
    }
    if (!Number.isFinite(rightBoundary[k])) {
      rightBoundary[k] = leftBoundary[k];
    }
  }

  return {
    score: bestScore,
    oldStart: 0,
    oldEnd: m,
    newStart: startJ,
    newEnd: endJ,
    leftBoundary,
    rightBoundary,
    stats,
  };
}

function ratioPosition(
  oldStart: number,
  oldLen: number,
  newLen: number
): number {
  if (oldLen === 0) {
    return 0;
  }
  return Math.round((oldStart / oldLen) * newLen);
}

function windowBounds(
  candidateQuoteStart: number,
  anchor: HydratedComment,
  newTextLength: number,
  options: Required<ReanchorOptions>
): [number, number] {
  const slack = Math.max(
    options.windowSlack,
    Math.ceil(
      (anchor.quote.length + anchor.prefix.length + anchor.suffix.length) / 2
    )
  );
  const start = clamp(
    candidateQuoteStart - anchor.prefix.length - slack,
    0,
    newTextLength
  );
  const end = clamp(
    candidateQuoteStart + anchor.quote.length + anchor.suffix.length + slack,
    0,
    newTextLength
  );
  return [start, Math.max(start, end)];
}

function candidateStarts(
  oldText: string,
  newText: string,
  anchor: HydratedComment,
  options: Required<ReanchorOptions>
): number[] {
  const { seeds, quoteStart } = buildSeeds(anchor, options);
  const candidates: number[] = [];
  const predicted = ratioPosition(anchor.start, oldText.length, newText.length);
  candidates.push(predicted);

  const exactQuoteHits = findAllOccurrences(
    newText,
    anchor.quote,
    options.maxSeedOccurrences
  );
  for (const idx of exactQuoteHits) {
    candidates.push(idx);
  }

  for (const seed of seeds.sort((a, b) => b.weight - a.weight)) {
    const hits = findAllOccurrences(
      newText,
      seed.text,
      options.maxSeedOccurrences + 1
    );
    if (hits.length === 0 || hits.length > options.maxSeedOccurrences) {
      continue;
    }
    for (const hit of hits) {
      const estimate = hit - seed.oldIndex + quoteStart;
      candidates.push(clamp(estimate, 0, newText.length));
    }
  }

  return uniqueSorted(candidates).slice(0, options.maxCandidates);
}

function scoreCandidate(
  anchor: HydratedComment,
  newText: string,
  start: number,
  end: number,
  alignment: SemiGlobalAlignment,
  predictedStart: number
): number {
  const newQuote = newText.slice(start, end);
  const quoteDen = Math.max(anchor.quote.length, newQuote.length, 1);
  const quoteSimilarity = clamp(
    alignment.stats.quoteExactMatches / quoteDen,
    0,
    1
  );
  const prefixActual = newText.slice(
    Math.max(0, start - anchor.prefix.length),
    start
  );
  const suffixActual = newText.slice(
    end,
    Math.min(newText.length, end + anchor.suffix.length)
  );
  const prefixSimilarity = prefixContextSimilarity(anchor.prefix, prefixActual);
  const suffixSimilarity = suffixContextSimilarity(anchor.suffix, suffixActual);
  const contextSimilarity = (prefixSimilarity + suffixSimilarity) / 2;
  const positionSimilarity =
    1 -
    Math.min(Math.abs(start - predictedStart) / Math.max(newText.length, 1), 1);
  const exactQuoteBonus = newQuote === anchor.quote ? 0.08 : 0;
  const nonEmptyPenalty = newQuote.length === 0 ? -1 : 0;
  return clamp(
    0.7 * quoteSimilarity +
      0.2 * contextSimilarity +
      0.1 * positionSimilarity +
      exactQuoteBonus +
      nonEmptyPenalty,
    0,
    1
  );
}

function bestExactQuoteHit(
  oldText: string,
  newText: string,
  anchor: HydratedComment,
  options: Required<ReanchorOptions>
): {
  start: number;
  end: number;
  confidence: number;
  ambiguous: boolean;
} | null {
  const hits = findAllOccurrences(
    newText,
    anchor.quote,
    options.maxSeedOccurrences + 1
  );
  if (hits.length === 0 || hits.length > options.maxSeedOccurrences) {
    return null;
  }
  const predicted = ratioPosition(anchor.start, oldText.length, newText.length);
  const scored = hits.map((start) => {
    const end = start + anchor.quote.length;
    const prefixActual = newText.slice(
      Math.max(0, start - anchor.prefix.length),
      start
    );
    const suffixActual = newText.slice(
      end,
      Math.min(newText.length, end + anchor.suffix.length)
    );
    const prefixSimilarity = prefixContextSimilarity(
      anchor.prefix,
      prefixActual
    );
    const suffixSimilarity = suffixContextSimilarity(
      anchor.suffix,
      suffixActual
    );
    const contextSimilarity = (prefixSimilarity + suffixSimilarity) / 2;
    const positionSimilarity =
      1 -
      Math.min(Math.abs(start - predicted) / Math.max(newText.length, 1), 1);
    const confidence = clamp(
      0.8 + 0.15 * contextSimilarity + 0.05 * positionSimilarity,
      0,
      1
    );
    return {
      start,
      end,
      confidence,
      rawScore: 0.85 * contextSimilarity + 0.15 * positionSimilarity,
      contextSimilarity,
    };
  });
  scored.sort((a, b) => b.rawScore - a.rawScore);
  if (scored.length === 1) {
    return {
      start: scored[0].start,
      end: scored[0].end,
      confidence: scored[0].confidence,
      ambiguous: false,
    };
  }
  const gap = scored[0].rawScore - scored[1].rawScore;
  const weakContext = scored[0].contextSimilarity < 0.6;
  return {
    start: scored[0].start,
    end: scored[0].end,
    confidence: scored[0].confidence,
    ambiguous: gap < options.ambiguityMargin || weakContext,
  };
}

export function reanchorComment(
  oldText: string,
  newText: string,
  comment: RawComment | HydratedComment,
  options: ReanchorOptions = {}
): ReanchoredComment {
  const cfg = { ...DEFAULTS, ...options };
  const anchor = hydrateComment(oldText, comment, cfg);

  if (anchor.quote.length === 0) {
    return {
      id: anchor.id,
      body: anchor.body,
      status: "removed",
      confidence: 1,
      reason: "empty-quote",
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    };
  }

  if (oldText === newText) {
    return {
      id: anchor.id,
      body: anchor.body,
      status: "resolved",
      start: anchor.start,
      end: anchor.end,
      confidence: 1,
      reason: "unchanged-document",
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    };
  }

  const fast = bestExactQuoteHit(oldText, newText, anchor, cfg);
  if (fast && !fast.ambiguous) {
    return {
      id: anchor.id,
      body: anchor.body,
      status: "resolved",
      start: fast.start,
      end: fast.end,
      confidence: fast.confidence,
      reason: "exact-quote",
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    };
  }

  const predictedStart = ratioPosition(
    anchor.start,
    oldText.length,
    newText.length
  );
  const { oldWindow, quoteStart, quoteEnd } = buildSeeds(anchor, cfg);
  const candidates = candidateStarts(oldText, newText, anchor, cfg);

  type CandidateResult = {
    score: number;
    start: number;
    end: number;
    alignment: SemiGlobalAlignment;
    windowStart: number;
  };
  const results: CandidateResult[] = [];

  for (const candidate of candidates) {
    const [windowStart, windowEnd] = windowBounds(
      candidate,
      anchor,
      newText.length,
      cfg
    );
    const windowText = newText.slice(windowStart, windowEnd);
    const alignment = semiglobalAlign(
      oldWindow,
      windowText,
      quoteStart,
      quoteEnd
    );
    let start = windowStart + alignment.rightBoundary[quoteStart];
    let end = windowStart + alignment.leftBoundary[quoteEnd];
    [start, end] = trimResolvedWhitespace(anchor.quote, newText, start, end);
    if (end <= start) {
      continue;
    }
    const score = scoreCandidate(
      anchor,
      newText,
      start,
      end,
      alignment,
      predictedStart
    );
    results.push({ score, start, end, alignment, windowStart });
  }

  const dedupedResults = new Map<string, CandidateResult>();
  for (const result of results) {
    const key = `${result.start}:${result.end}`;
    const current = dedupedResults.get(key);
    if (!current || result.score > current.score) {
      dedupedResults.set(key, result);
    }
  }
  const ranked = [...dedupedResults.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];

  if (!best) {
    return {
      id: anchor.id,
      body: anchor.body,
      status: "removed",
      confidence: 0,
      reason: "no-candidate",
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    };
  }

  if (best.score < cfg.minConfidence) {
    return {
      id: anchor.id,
      body: anchor.body,
      status: "removed",
      confidence: best.score,
      reason: "low-confidence",
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    };
  }

  if (second && best.score - second.score < cfg.ambiguityMargin) {
    return {
      id: anchor.id,
      body: anchor.body,
      status: "ambiguous",
      confidence: best.score,
      reason: "multiple-plausible-matches",
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    };
  }

  if (fast?.ambiguous && newText.slice(best.start, best.end) === anchor.quote) {
    return {
      id: anchor.id,
      body: anchor.body,
      status: "ambiguous",
      confidence: best.score,
      reason: "ambiguous-exact-quote",
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    };
  }

  return {
    id: anchor.id,
    body: anchor.body,
    status: "resolved",
    start: best.start,
    end: best.end,
    confidence: best.score,
    reason: "aligned-window",
    quote: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
  };
}

export function reanchorComments(
  oldText: string,
  newText: string,
  comments: RawComment[],
  options: ReanchorOptions = {}
): ReanchoredComment[] {
  return comments.map((comment) =>
    reanchorComment(oldText, newText, comment, options)
  );
}

export function resolvedCommentsOnly(
  oldText: string,
  newText: string,
  comments: RawComment[],
  options: ReanchorOptions = {}
): RawComment[] {
  return reanchorComments(oldText, newText, comments, options)
    .filter((comment) => comment.status === "resolved")
    .map((comment) => ({
      id: comment.id,
      body: comment.body,
      start: comment.start!,
      end: comment.end!,
      quote: comment.quote,
      prefix: comment.prefix,
      suffix: comment.suffix,
    }));
}
