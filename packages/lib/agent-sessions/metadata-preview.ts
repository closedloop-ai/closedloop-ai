import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { redactSecrets } from "../security/redact-secrets";

/**
 * FEA-3693: the ONE shared, version-skew-safe long-message transcript-preview
 * contract for persisted/synced session `metadata` blobs.
 *
 * Both the desktop sync producer (`compactSessionMetadataForSync` in
 * `apps/desktop/src/main/agent-sync/agent-session-sync-payload.ts`) and the
 * cloud persist boundary (`sanitizeMetadataForPersist` in
 * `apps/api/app/agent-sessions/service/metadata-sanitizer.ts`) delegate here, so
 * the two lanes cannot drift: for the SAME normalized transcript input they emit
 * byte-identical `metadata`. Before this module they were hand-duplicated and had
 * contradictory long-message policies — desktop kept a per-message preview floor
 * after the aggregate byte budget while the cloud dropped later `text` entirely,
 * so session rows and detail disagreed on long conversations.
 *
 * This package is surface-agnostic and browser-safe (no Node built-ins, see
 * `@repo/lib` AGENTS.md): it is bundled into the Electron main process AND
 * resolved as source by `apps/api`, which is why the single policy can be shared
 * by construction.
 */

/** Max object-nesting depth retained; deeper objects collapse to `null`. */
export const MAX_METADATA_DEPTH = 4;
/** Max own-keys retained per object (extra keys dropped). */
export const MAX_METADATA_KEYS = 80;
/** Max items retained per array (extra items dropped). */
export const MAX_METADATA_ARRAY_ITEMS = 100;
/** Max chars retained for a generic (non-message-text) string field. */
export const MAX_METADATA_STRING_CHARS = 1024;
/** Max messages retained from `metadata.messages[]` (extra messages dropped). */
export const MAX_METADATA_MESSAGES = 100;
/**
 * Per-message text preview cap. The effective ceiling for how much human/
 * assistant turn text reaches the cloud DB and renders in the branch merged
 * trace / `SessionDetail.timeline[].detail`. Sized (Mike, FEA-3672) as
 * `max(2500, golden-corpus p95 of 1361)`, bounded by the parser's 4096-byte
 * `truncateText` ceiling. Stays a sanitized preview — full text lives in the
 * FEA-2717 transcript archive.
 */
export const MAX_METADATA_MESSAGE_TEXT_CHARS = 2500;
/**
 * Aggregate cap on preview text summed across ALL messages in one session,
 * independent of the per-message cap. The full `metadata` blob is replicated
 * into every desktop sync chunk and measured against the 256 KiB payload cap;
 * 100 messages at the per-message cap (~250 KiB) would blow it and dead-letter
 * the session. This budget bounds the summed preview well under the payload cap.
 * Once exhausted, later messages fall back to the per-message FLOOR below (they
 * never drop `text` entirely).
 */
export const MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS = 60_000;
/**
 * Per-message FLOOR that survives the aggregate budget. Without it, once the
 * running budget is exhausted every later message drops `text` — regressing
 * those turns to no preview and hiding the most recent prompts in long sessions.
 * The old FEA-3033 value (160), chosen so the floor can never itself dead-letter
 * a session: worst case
 * `MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS + MAX_METADATA_MESSAGES × 160` ≈ 76 KiB
 * — comfortably under the 256 KiB payload cap.
 */
export const MIN_METADATA_MESSAGE_TEXT_CHARS = 160;
/** Keys stripped entirely from every metadata object. */
export const OMITTED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "tokenSeries",
]);

/**
 * FEA-3693 truncation metadata attached to each compacted message so a UI can
 * truthfully distinguish previewed / omitted / complete content instead of
 * silently rendering a truncated slice as if it were the full turn. Emitted ONLY
 * for messages that carried `text`; absent text stays fully OMITTED (no `text`,
 * no `textTruncation`).
 *
 * - `complete`  — the full turn text was retained (no truncation applied).
 * - `previewed` — the stored `text` is a bounded slice; the full turn is longer
 *   and lives only in the transcript archive. Includes floor-clamped messages
 *   (aggregate budget exhausted) whose slice is shorter than the source.
 */
export type MetadataMessageTextTruncation = "complete" | "previewed";

export const METADATA_MESSAGE_TEXT_TRUNCATION_KEY = "textTruncation" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduce an arbitrary `metadata` blob to the bounded, content-stripped shape
 * both lanes are allowed to persist/sync. Returns `null` for non-objects and for
 * objects that compact to nothing. Deterministic and idempotent: a
 * already-compacted, already-capped blob is returned unchanged (aside from
 * re-derivable `textTruncation` markers).
 */
export function compactMetadataForPreview(
  metadata: unknown
): JsonObject | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const compacted = compactMetadataObject(metadata, 0);
  return compacted && Object.keys(compacted).length > 0 ? compacted : null;
}

function compactMetadataObject(
  metadata: Record<string, unknown>,
  depth: number
): JsonObject | null {
  if (depth > MAX_METADATA_DEPTH) {
    return null;
  }
  const compacted: JsonObject = {};
  for (const [key, value] of Object.entries(metadata).slice(
    0,
    MAX_METADATA_KEYS
  )) {
    if (OMITTED_METADATA_KEYS.has(key)) {
      continue;
    }
    const compactValue =
      key === "messages"
        ? compactMetadataMessages(value)
        : compactMetadataValue(value, depth + 1);
    if (compactValue !== undefined) {
      compacted[key] = compactValue;
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : null;
}

function compactMetadataMessages(value: unknown): JsonValue {
  if (!Array.isArray(value)) {
    return compactMetadataValue(value, 1) ?? null;
  }
  // Running budget for preview text summed across all messages, so a long
  // conversation of near-cap turns cannot bloat metadata past the payload byte
  // cap and dead-letter the whole session. Per-message cap still applies; this
  // only bounds the AGGREGATE. Once exhausted, messages fall back to the
  // per-message FLOOR (never dropping `text` entirely) — the single policy both
  // lanes now share (FEA-3693).
  let remainingTextChars = MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS;
  return value.slice(0, MAX_METADATA_MESSAGES).map((item) => {
    if (!isRecord(item)) {
      return null;
    }
    const compacted: JsonObject = {};
    copyStringMetadata(item, compacted, "role", MAX_METADATA_STRING_CHARS);
    copyStringMetadata(item, compacted, "timestamp", MAX_METADATA_STRING_CHARS);
    copyStringMetadata(item, compacted, "model", MAX_METADATA_STRING_CHARS);
    const perMessageTextCap = Math.min(
      MAX_METADATA_MESSAGE_TEXT_CHARS,
      Math.max(remainingTextChars, MIN_METADATA_MESSAGE_TEXT_CHARS)
    );
    if (perMessageTextCap > 0) {
      remainingTextChars -= copyRedactedText(
        item,
        compacted,
        perMessageTextCap
      );
    }
    copyBooleanMetadata(item, compacted, "isThinking");
    copyBooleanMetadata(item, compacted, "isSynthetic");
    return compacted;
  });
}

function compactMetadataValue(
  value: unknown,
  depth: number
): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value, MAX_METADATA_STRING_CHARS);
  }
  if (Array.isArray(value)) {
    if (depth > MAX_METADATA_DEPTH) {
      return [];
    }
    return value
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .map((item) => compactMetadataValue(item, depth + 1) ?? null);
  }
  if (isRecord(value)) {
    return compactMetadataObject(value, depth);
  }
  return undefined;
}

function copyStringMetadata(
  source: Record<string, unknown>,
  target: JsonObject,
  key: string,
  maxChars: number
): void {
  const value = source[key];
  if (typeof value === "string") {
    target[key] = truncateString(value, maxChars);
  }
}

function copyBooleanMetadata(
  source: Record<string, unknown>,
  target: JsonObject,
  key: string
): void {
  const value = source[key];
  if (typeof value === "boolean") {
    target[key] = value;
  }
}

/**
 * FEAT 019f881c: copy the message `text` preview with pattern-based secret
 * redaction applied via the shared `@repo/lib/security/redact-secrets` SSOT.
 * Redaction runs BEFORE the length cap so a secret at the truncation boundary
 * can never leave a partial-key fragment in the stored/synced preview.
 *
 * FEA-3693: also stamps `textTruncation` so the UI can distinguish a full turn
 * from a bounded preview. Absent/non-string source `text` is left OMITTED (no
 * `text`, no marker). Returns the number of stored `text` chars so the caller
 * can debit the aggregate budget.
 */
function copyRedactedText(
  source: Record<string, unknown>,
  target: JsonObject,
  maxChars: number
): number {
  const value = source.text;
  if (typeof value !== "string") {
    return 0;
  }
  const redacted = redactSecrets(value);
  const stored = truncateString(redacted, maxChars);
  target.text = stored;
  const wasAlreadyPreviewed =
    source[METADATA_MESSAGE_TEXT_TRUNCATION_KEY] === "previewed";
  const truncation: MetadataMessageTextTruncation =
    stored.length < redacted.length || wasAlreadyPreviewed
      ? "previewed"
      : "complete";
  target[METADATA_MESSAGE_TEXT_TRUNCATION_KEY] = truncation;
  return stored.length;
}

function truncateString(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
