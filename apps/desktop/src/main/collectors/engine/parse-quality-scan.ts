/**
 * @file parse-quality-scan.ts
 * @description FEA-2905: the canonical JSONL line-scan-with-parse-quality helper
 * shared by the transcript parsers. Streaming a `.jsonl` transcript and tracking
 * malformed-line drops was duplicated across the Claude parser's main
 * `parseSessionFile` loop and its subagent-sidecar reader — `readAgentFile`
 * since the ISS-6531 rewrite deleted `collectEntriesFromFile` (ISS-6576). Both
 * need identical semantics so a corrupt line surfaces as a parse-quality signal
 * instead of a silent turn drop, which is why they share this helper rather
 * than each streaming their own way.
 *
 * `readJsonlLinesWithQuality` streams a file line by line, skips blank lines,
 * JSON-parses each non-blank line, and yields only the successfully-parsed
 * entries (paired with their raw line text). Malformed lines are counted, not
 * yielded — matching the parsers' `continue`-on-parse-error posture. The running
 * quality counters live on a `ParseQualityScan` tracker the caller reads after
 * the loop drains:
 *   - `totalLines`         — non-blank lines seen (parsed + malformed).
 *   - `malformedLines`     — non-blank lines that failed `JSON.parse`.
 *   - `lastLineMalformed`  — whether the final non-blank line was malformed. A
 *                            malformed FINAL line is the benign shape of a
 *                            truncated in-progress write; callers surface it as
 *                            `truncatedFinalLine` and may discount it.
 *
 * Parser-agnostic by design: it yields raw parsed records so each parser applies
 * its own per-entry logic. The Codex parser (#2552) is expected to adopt this
 * same helper in a fast-follow.
 */
import { createReadStream } from "node:fs";
import readline from "node:readline";

/** Running parse-quality counters, read by the caller after the scan drains. */
export type ParseQualityScan = {
  /** Non-blank lines seen (successfully parsed + malformed). */
  totalLines: number;
  /** Non-blank lines that failed `JSON.parse` and were skipped. */
  malformedLines: number;
  /**
   * Whether the last non-blank line was malformed. A malformed final line is the
   * benign shape of a live/interrupted write; callers report it as
   * `truncatedFinalLine`.
   */
  lastLineMalformed: boolean;
};

/** A successfully-parsed JSONL line: its raw text and decoded object. */
export type ParsedJsonlLine = {
  line: string;
  entry: Record<string, unknown>;
};

/**
 * Stream a JSONL file, yielding each successfully-parsed line while accumulating
 * parse-quality counts onto `scan`. Blank lines are skipped (not counted).
 * Malformed lines increment `scan.malformedLines`/`scan.lastLineMalformed` and
 * are skipped rather than yielded. Read `scan` after the generator drains.
 */
export async function* readJsonlLinesWithQuality(
  filePath: string,
  scan: ParseQualityScan
): AsyncGenerator<ParsedJsonlLine> {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    scan.totalLines++;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      scan.malformedLines++;
      scan.lastLineMalformed = true;
      continue;
    }
    scan.lastLineMalformed = false;
    yield { line, entry };
  }
}

/** Create a fresh, zeroed parse-quality scan tracker. */
export function createParseQualityScan(): ParseQualityScan {
  return { totalLines: 0, malformedLines: 0, lastLineMalformed: false };
}

/** A child file's parse-quality summary, as folded into a parent scan. */
export type ChildParseQuality = {
  /** Non-blank lines seen in the child file. */
  totalLines: number;
  /** Non-blank lines in the child that failed `JSON.parse`. */
  malformedLines: number;
  /**
   * Whether the child's final non-blank line was malformed — the benign shape
   * of a live/interrupted write, discounted when folding into the parent.
   */
  truncatedFinalLine: boolean;
};

/**
 * Fold a child transcript/journal's parse-quality into a parent's running
 * counts (FEA-2905 / FEA-2972). A corrupt child line silently drops that turn's
 * folded token usage, so the malformed count must surface on the parent's
 * `parseQuality` rather than read as a clean parse. The child's OWN trailing
 * truncation is benign (a live/interrupted write), so it is discounted here
 * exactly as the main transcript's `truncatedFinalLine` is — only genuine
 * mid-file corruption inflates the parent's `malformedLines`. `malformedLines`
 * is always >= its own truncation term, so the subtraction never goes negative.
 * `truncatedFinalLine` stays a property of the parent's main file, never the
 * child's, so it is intentionally not propagated onto the parent.
 *
 * The parent target is structural — the two line counts plus the ISS-6336
 * discount tally — so both the desktop `ParseQualityScan` (inline collectors)
 * and the extracted parser cores' post-normalization `NormalizedParseQuality`
 * (FEA-2717, whose last field is named `truncatedFinalLine` not
 * `lastLineMalformed`) can be folded into.
 */
export function foldChildParseQuality(
  parent: FoldTarget,
  child: ChildParseQuality
): void {
  parent.totalLines += child.totalLines;
  const childCorrupt = corruptLineCount(child);
  parent.malformedLines += childCorrupt;
  // ISS-12036: attribute the same number this fold just added, so the child's
  // share and the parent's own are separable afterwards. Written only when it
  // grows past zero, so a clean fold leaves the key absent.
  if (childCorrupt > 0) {
    parent.foldedChildMalformedLines =
      (parent.foldedChildMalformedLines ?? 0) + childCorrupt;
  }
  if (child.truncatedFinalLine) {
    // ISS-6336 (whitlockk review): the line above just discounted this child's
    // trailing truncation out of the numerator while leaving it in
    // `totalLines`. Recording the discount is what lets a ratio reader put the
    // two back on the same footing; without it an all-corrupt multi-file
    // session measures as partially readable.
    parent.childTruncatedFinalLines =
      (parent.childTruncatedFinalLines ?? 0) + 1;
  }
}

/**
 * Lines a parse-quality summary reports as GENUINELY corrupt: its malformed
 * count with a benign trailing truncation discounted.
 *
 * The canonical form of the expression the `NormalizedParseQuality` contract
 * prescribes. It was re-derived at every reader, so a change to how truncation
 * is discounted had to be found in each of them — and finding all but one still
 * ships a wrong answer from the one that was missed.
 *
 * `malformedLines` is always >= its own truncation term, so this never goes
 * negative. Structural in its input so both the desktop `ParseQualityScan` and
 * the post-normalization `NormalizedParseQuality` (whose field is named
 * `truncatedFinalLine`, not `lastLineMalformed`) can be measured by it.
 */
export function corruptLineCount(
  quality: Pick<ChildParseQuality, "malformedLines" | "truncatedFinalLine">
): number {
  return quality.malformedLines - (quality.truncatedFinalLine ? 1 : 0);
}

/**
 * The parent target a child folds into: structural, so both the desktop
 * `ParseQualityScan` and the post-normalization `NormalizedParseQuality` satisfy
 * it. `childTruncatedFinalLines` and `foldedChildMalformedLines` are optional and
 * written only when a child actually carried a trailing truncation or corrupt
 * lines, so a clean fold leaves both keys absent exactly as the sibling optional
 * counters do.
 */
type FoldTarget = Pick<ParseQualityScan, "totalLines" | "malformedLines"> & {
  childTruncatedFinalLines?: number;
  /** ISS-12036: the folded-child share of `malformedLines`, written when non-zero. */
  foldedChildMalformedLines?: number;
};

/**
 * Lines a parse-quality summary COULD have reported corrupt — the denominator
 * {@link corruptLineCount} is measured against.
 *
 * Every benign trailing truncation is discounted, the parent's own and each
 * child's alike, because a discounted line is not available to be counted. Pair
 * this with `corruptLineCount`: measuring a discounted numerator against an
 * undiscounted total is what made "every line was lost" unreachable for the
 * short and multi-file transcripts where it is most likely to be true.
 */
export function corruptibleLineCount(
  quality: Pick<ChildParseQuality, "totalLines" | "truncatedFinalLine"> & {
    childTruncatedFinalLines?: number;
  }
): number {
  return (
    quality.totalLines -
    (quality.truncatedFinalLine ? 1 : 0) -
    (quality.childTruncatedFinalLines ?? 0)
  );
}
