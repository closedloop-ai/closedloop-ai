import { truncateUtf8 } from "@repo/observability/truncate-utf8";

/**
 * Byte-accurate, character-safe truncation for content caps, with the metadata
 * a caller needs to report what it dropped.
 *
 * The truncation itself is NOT reimplemented here — it delegates to the
 * canonical `truncateUtf8` (`packages/loops-api/src/observability/truncate-utf8.ts`,
 * re-exported through `@repo/observability/truncate-utf8`). This module only
 * adds the before/after byte accounting, because a caller that truncates a
 * document has to log the original size and cannot recover it from the
 * truncated string.
 *
 * Why a byte cap at all: a cap expressed in bytes ("1MB") but measured with
 * `String.prototype.length` measures the wrong thing, because `.length` counts
 * UTF-16 code units. Every ASCII character is one code unit and one byte, so an
 * ASCII-only fixture makes the two look identical — but a CJK document encodes
 * at 3 bytes per code unit and emoji/astral characters at 4, so a `.length` cap
 * silently admits a document at up to 4x the intended byte size. Truncating on
 * a UTF-8 byte boundary also keeps every character whole, so an astral
 * character's surrogate pair can never be split into a lone surrogate.
 */

export type Utf8Truncation = {
  /** The text, truncated only if it exceeded the budget. */
  text: string;
  /** UTF-8 byte length of {@link text}. Never above the requested budget. */
  byteLength: number;
  /** UTF-8 byte length of the input, before any truncation. */
  originalByteLength: number;
  /** True only when bytes were actually dropped. */
  truncated: boolean;
};

/**
 * Truncate `text` so its UTF-8 encoding is at most `maxBytes`, never splitting a
 * character, and report the before/after byte lengths.
 *
 * A negative or fractional budget is clamped to a whole, non-negative byte count
 * BEFORE delegating. That guard is load-bearing rather than defensive tidiness:
 * the canonical `truncateUtf8` validates nothing, so a negative budget reaches
 * `TypedArray#subarray`'s negative-index semantics and counts from the END of
 * the string (returning nearly all of it instead of truncating), and a
 * fractional budget makes the continuation-byte walk-back's index lookup
 * `undefined`, skipping the walk-back entirely and emitting a split character.
 * Clamping here keeps both unreachable through this helper.
 */
export function truncateToUtf8Bytes(
  text: string,
  maxBytes: number
): Utf8Truncation {
  const budget = Math.max(0, Math.floor(maxBytes));
  const originalByteLength = byteLengthOf(text);

  if (originalByteLength <= budget) {
    return {
      text,
      byteLength: originalByteLength,
      originalByteLength,
      truncated: false,
    };
  }

  const truncated = truncateUtf8(text, budget);
  return {
    text: truncated,
    byteLength: byteLengthOf(truncated),
    originalByteLength,
    truncated: true,
  };
}

// `Buffer.byteLength` measures without allocating; `new TextEncoder().encode()`
// would allocate a full encoded copy of the document just to read a number, on
// the non-truncating path too. Drive exports run to 10MB with several in
// flight, so that copy is worth not making. This is also the byte-measuring
// idiom used throughout apps/api.
function byteLengthOf(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
