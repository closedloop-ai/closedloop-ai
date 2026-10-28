import type { XmlFragment } from "yjs";
import {
  type CommentMarkAttrs,
  collectTextRuns,
  commentMarkAttribute,
  readCommentMarkAttribute,
  type TextRun,
} from "./comment-anchor";

/**
 * PLN-2187 T-3.1: comment marks on a document's Yjs fragment, in flattened
 * coordinates (`./comment-anchor-flatten`). Yjs only, no DOM: doc-sync and
 * the editor read marks through the same function. Every write runs in one
 * transaction on the fragment's document.
 */

/** A run of text one thread's mark covers; a block boundary inside a mark does not split it. */
export type CommentMarkRange = {
  threadId: string;
  start: number;
  end: number;
  orphan: boolean;
};

export type FlatTextRange = { start: number; end: number };

export function readCommentMarks(fragment: XmlFragment): CommentMarkRange[] {
  const { runs, blockStarts } = collectTextRuns(fragment);
  const blockStartSet = new Set(blockStarts);
  const lastRange = new Map<string, CommentMarkRange>();
  const ranges: CommentMarkRange[] = [];
  for (const run of runs) {
    const end = run.start + run.text.length;
    for (const { attrs } of runMarks(run)) {
      const identity = `${attrs.orphan}:${attrs.threadId}`;
      const last = lastRange.get(identity);
      if (
        last !== undefined &&
        continuesRange(last, run.start, blockStartSet)
      ) {
        last.end = end;
        continue;
      }
      const range = { ...attrs, start: run.start, end };
      ranges.push(range);
      lastRange.set(identity, range);
    }
  }
  return ranges.sort(compareMarkRanges);
}

/**
 * Marks `range` for `threadId` with `{ orphan: false, threadId }`, skipping
 * the block separators inside it. Throws a RangeError for a range that is
 * empty, outside the flattened text, or covers only block separators.
 */
export function applyCommentMarkToRange(
  fragment: XmlFragment,
  range: FlatTextRange,
  threadId: string
): void {
  const { runs, text } = collectTextRuns(fragment);
  if (
    !(
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.start < range.end &&
      range.end <= text.length
    )
  ) {
    throw new RangeError(
      `Comment mark range [${range.start}, ${range.end}) is outside the document text (length ${text.length})`
    );
  }
  const writes = runs.flatMap((run) => {
    const from = Math.max(range.start, run.start) - run.start;
    const to = Math.min(range.end, run.start + run.text.length) - run.start;
    return to > from ? [{ run, from, length: to - from }] : [];
  });
  if (writes.length === 0) {
    throw new RangeError(
      `Comment mark range [${range.start}, ${range.end}) covers no text, only block separators`
    );
  }
  const { key, value } = commentMarkAttribute(threadId);
  inTransaction(fragment, () => {
    for (const { run, from, length } of writes) {
      run.node.format(run.nodeOffset + from, length, { [key]: value });
    }
  });
}

/** Removes every mark of `threadIds`; returns the ids that had one, in request order. */
export function removeCommentMarks(
  fragment: XmlFragment,
  threadIds: Iterable<string>
): string[] {
  const requested = new Set(threadIds);
  const touched = rewriteCommentMarks(fragment, (attrs) =>
    requested.has(attrs.threadId) ? null : undefined
  );
  return [...requested].filter((threadId) => touched.has(threadId));
}

/**
 * Moves every mark of each `from` thread to its `to` thread, keeping the
 * orphan flag; returns the `from` ids that had a mark, in mapping order.
 */
export function renameCommentMarks(
  fragment: XmlFragment,
  mapping: ReadonlyMap<string, string>
): string[] {
  const touched = rewriteCommentMarks(fragment, (attrs) => {
    const to = mapping.get(attrs.threadId);
    return to === undefined
      ? undefined
      : commentMarkAttribute(to, attrs.orphan);
  });
  return [...mapping.keys()].filter((threadId) => touched.has(threadId));
}

/** Flags every live mark of `threadId` orphan; true when it had one. */
export function setCommentMarkOrphan(
  fragment: XmlFragment,
  threadId: string
): boolean {
  const touched = rewriteCommentMarks(fragment, (attrs) =>
    attrs.threadId === threadId && !attrs.orphan
      ? commentMarkAttribute(threadId, true)
      : undefined
  );
  return touched.has(threadId);
}

function runMarks(run: TextRun): { key: string; attrs: CommentMarkAttrs }[] {
  const marks: { key: string; attrs: CommentMarkAttrs }[] = [];
  for (const [key, value] of Object.entries(run.attributes)) {
    const attrs = readCommentMarkAttribute(key, value);
    if (attrs !== null) {
      marks.push({ key, attrs });
    }
  }
  return marks;
}

/**
 * Rewrites each comment mark `replace` answers for: `null` removes it, an
 * attribute replaces it, `undefined` leaves it. Returns the thread ids of the
 * marks it rewrote. Each run is formatted once, removals before replacements,
 * so one mark's replacement survives another mark's removal on the same run
 * (a rename of A to B and B to C, or a swap).
 */
function rewriteCommentMarks(
  fragment: XmlFragment,
  replace: (
    attrs: CommentMarkAttrs
  ) => { key: string; value: CommentMarkAttrs } | null | undefined
): Set<string> {
  const { runs } = collectTextRuns(fragment);
  const touched = new Set<string>();
  inTransaction(fragment, () => {
    for (const run of runs) {
      const removals: Record<string, null> = {};
      const replacements: Record<string, CommentMarkAttrs> = {};
      for (const { key, attrs } of runMarks(run)) {
        const replacement = replace(attrs);
        if (replacement === undefined) {
          continue;
        }
        removals[key] = null;
        if (replacement !== null) {
          replacements[replacement.key] = replacement.value;
        }
        touched.add(attrs.threadId);
      }
      if (Object.keys(removals).length > 0) {
        run.node.format(run.nodeOffset, run.text.length, {
          ...removals,
          ...replacements,
        });
      }
    }
  });
  return touched;
}

/** A run that starts where the range ends, or right after the separator ending its block. */
function continuesRange(
  range: CommentMarkRange,
  runStart: number,
  blockStarts: ReadonlySet<number>
): boolean {
  return (
    range.end === runStart ||
    (range.end + 1 === runStart && blockStarts.has(runStart))
  );
}

function compareMarkRanges(a: CommentMarkRange, b: CommentMarkRange): number {
  if (a.start !== b.start) {
    return a.start - b.start;
  }
  if (a.end !== b.end) {
    return a.end - b.end;
  }
  if (a.threadId !== b.threadId) {
    return a.threadId < b.threadId ? -1 : 1;
  }
  return Number(a.orphan) - Number(b.orphan);
}

function inTransaction(fragment: XmlFragment, work: () => void): void {
  if (fragment.doc === null) {
    work();
    return;
  }
  fragment.doc.transact(work);
}
