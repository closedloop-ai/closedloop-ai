/**
 * The SIZE bound every caller-supplied identifier passes through before it
 * enters a desktop-sync log line, stated once.
 *
 * ISS-8781 lifted it out of `upsert-sessions-batch.ts` so the omission report
 * can bound the ids it samples. Importing it from that file would have been a
 * cycle (the batch imports the report), and re-declaring the byte ceiling or the
 * truncation marker would have left two readers to keep them in step — the
 * SSOT-drift-by-copy defect `AGENTS.md` names. Behaviour is unchanged from the
 * ISS-8881 original.
 */
import { truncateToUtf8Bytes } from "@/lib/truncate-utf8";

/**
 * ISS-8881 (davetho review): how many UTF-8 bytes of ONE sampled identifier a
 * warn may carry.
 *
 * A cardinality cap bounds HOW MANY identifiers are logged; it bounds nothing
 * about their SIZE. `componentKey` and `externalSessionId` both arrive from the
 * wire as `z.string().trim().min(1)` with no maximum, so twenty multi-MiB
 * identifiers are twenty times a cap that was only ever counting entries — and
 * because the payload is deterministic and re-sent on every sync, a corrupt
 * producer writes that record on every retry, forever. Two caps are needed, not
 * one.
 *
 * 256 bytes is well past any real component key or session id and short enough
 * that twenty of them stay a log line. Truncated identifiers are marked, so a
 * reader is never handed a prefix that looks like a whole value.
 */
export const MAX_SAMPLED_IDENTIFIER_BYTES = 256;

/**
 * What marks an identifier the cap actually bound, so a reader is never handed a
 * prefix that looks like a whole value.
 */
export const SAMPLED_IDENTIFIER_TRUNCATION_MARKER = "…[truncated]";

/**
 * The marker's own size, RESERVED out of the budget rather than added on top of
 * it.
 *
 * ISS-8781: truncating to `MAX_SAMPLED_IDENTIFIER_BYTES` and then appending the
 * marker emitted 270 bytes — U+2026 is three UTF-8 bytes, not one, plus eleven
 * for `[truncated]` — so the constant above promised a ceiling this function did
 * not keep. Measured rather than counted, for exactly the `.length` reason the
 * cap itself is measured in bytes.
 */
const SAMPLED_IDENTIFIER_TRUNCATION_MARKER_BYTES = Buffer.byteLength(
  SAMPLED_IDENTIFIER_TRUNCATION_MARKER,
  "utf8"
);

/**
 * Bound one caller-supplied identifier before it enters a warn.
 *
 * Byte-accurate rather than `.length`-accurate, and character-safe, because
 * `.length` counts UTF-16 code units: a CJK key encodes at 3 bytes per unit and
 * emoji at 4, so a `.length` cap admits up to 4x the intended bytes and can
 * split an astral character into a lone surrogate. `truncateToUtf8Bytes` is the
 * canonical helper for both.
 *
 * The RESULT is what is bounded, marker included — an identifier that fits the
 * cap whole is returned untouched, and one that does not is truncated to the
 * budget the marker leaves behind.
 */
export function boundSampledIdentifier(value: string): string {
  const bounded = truncateToUtf8Bytes(
    value,
    MAX_SAMPLED_IDENTIFIER_BYTES - SAMPLED_IDENTIFIER_TRUNCATION_MARKER_BYTES
  );
  if (bounded.originalByteLength <= MAX_SAMPLED_IDENTIFIER_BYTES) {
    return value;
  }
  return `${bounded.text}${SAMPLED_IDENTIFIER_TRUNCATION_MARKER}`;
}
