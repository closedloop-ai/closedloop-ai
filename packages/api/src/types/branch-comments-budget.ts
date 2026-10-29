/**
 * Byte-budget enforcement for PR comments responses.
 *
 * Behavior, not shape, so it lives beside `branch.ts` rather than in it: both
 * the producer (`branch-comments-service`) and the response contract need the
 * same ceilings applied the same way, and a types module that also carries the
 * trimming logic pulls a `TextEncoder` into every shape-only importer.
 */

import {
  BranchCommentsBudget,
  BranchCommentsState,
  type BranchPrCommentsResponse,
} from "./branch.ts";

const ENCODER = new TextEncoder();

/** A UTF-16 code unit is at most 3 UTF-8 bytes; a surrogate pair is 2 units / 4. */
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

/** U+D800 and U+DBFF — the high (lead) surrogate range. */
const HIGH_SURROGATE_MIN = 55_296;
const HIGH_SURROGATE_MAX = 56_319;
/** U+DC00 and U+DFFF — the low (trail) surrogate range. */
const LOW_SURROGATE_MIN = 56_320;
const LOW_SURROGATE_MAX = 57_343;
/** U+0080 — the first code point that needs 2 UTF-8 bytes. */
const UTF8_TWO_BYTE_FLOOR = 128;
/** U+0800 — the first code point that needs 3 UTF-8 bytes. */
const UTF8_THREE_BYTE_FLOOR = 2048;

/**
 * Trim a PR comment body to the shared comments byte budget.
 *
 * ISS-8329: measure the UTF-8 cost of each code unit in one forward pass and
 * slice the ORIGINAL string at the last unit that fits. O(n) instead of the
 * previous O(n²) loop that re-encoded the entire remaining string on every
 * one-code-unit iteration.
 *
 * Slicing the source string is load-bearing, not incidental: cutting an encoded
 * copy and decoding it back rewrites code units the old loop preserved — a
 * leading BOM is consumed (`TextDecoder` defaults to `ignoreBOM: false`) and a
 * retained lone surrogate becomes U+FFFD, both reachable through JSON escapes
 * (davetho review).
 */
export function trimBranchPrCommentBody(body: string): {
  body: string;
  truncated: boolean;
} {
  if (
    body.length * MAX_UTF8_BYTES_PER_CODE_UNIT <=
    BranchCommentsBudget.MaxBodyBytes
  ) {
    return { body, truncated: false };
  }
  const cut = utf8PrefixCodeUnitCount(body, BranchCommentsBudget.MaxBodyBytes);
  if (cut === body.length) {
    return { body, truncated: false };
  }
  return { body: body.slice(0, cut), truncated: true };
}

/** Enforce the shared serialized response budget for PR comments responses. */
export function fitBranchPrCommentsResponseBudget(
  response: BranchPrCommentsResponse
): BranchPrCommentsResponse {
  const next = { ...response, comments: [...response.comments] };
  while (
    next.comments.length > 0 &&
    byteLength(JSON.stringify(next)) > BranchCommentsBudget.MaxResponseBytes
  ) {
    next.comments.pop();
    next.budget.responseTruncated = true;
    next.budget.omittedComments += 1;
  }
  if (next.budget.responseTruncated) {
    next.state = BranchCommentsState.OverLimitTruncated;
  }
  return next;
}

function byteLength(value: string): number {
  return ENCODER.encode(value).byteLength;
}

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

/**
 * UTF-8 bytes that appending `code` adds to a prefix ending in `previous`.
 *
 * An unpaired surrogate costs 3 because that is what `TextEncoder` emits for one
 * (U+FFFD). So a low surrogate that COMPLETES a pair adds only 1: its lead unit
 * was already charged 3 as a lone surrogate, and the pair is 4.
 */
function utf8ByteCostOfCodeUnit(code: number, previous: number): number {
  if (isLowSurrogate(code) && isHighSurrogate(previous)) {
    return 1;
  }
  if (code < UTF8_TWO_BYTE_FLOOR) {
    return 1;
  }
  if (code < UTF8_THREE_BYTE_FLOOR) {
    return 2;
  }
  return MAX_UTF8_BYTES_PER_CODE_UNIT;
}

/**
 * Length, in UTF-16 code units, of the longest prefix of `value` whose UTF-8
 * encoding fits in `maxBytes`.
 *
 * Equivalent to the old drop-one-code-unit-and-re-encode loop: per-unit cost is
 * always >= 1, so the running total is strictly increasing and the first unit
 * that overflows ends the walk.
 */
function utf8PrefixCodeUnitCount(value: string, maxBytes: number): number {
  let bytes = 0;
  let cut = 0;
  for (let index = 0; index < value.length; index++) {
    const previous = index > 0 ? value.charCodeAt(index - 1) : 0;
    const cost = utf8ByteCostOfCodeUnit(value.charCodeAt(index), previous);
    if (bytes + cost > maxBytes) {
      break;
    }
    bytes += cost;
    cut = index + 1;
  }
  return cut;
}
