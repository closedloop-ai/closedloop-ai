import { createHash } from "node:crypto";

export function buildEventDedupKey(
  eventType: string,
  ts: string,
  toolName: string | null | undefined,
  discriminator?: string | null
): string {
  return `${eventType}|${ts}|${toolName == null ? "\0" : toolName}${discriminator ? `|${discriminator}` : ""}`;
}

export function deterministicEventId(
  sessionId: string,
  eventType: string,
  ts: string,
  toolName: string | null | undefined,
  discriminator?: string | null
): string {
  const dedupKey = buildEventDedupKey(eventType, ts, toolName, discriminator);
  return uuidV4FromInput(`${sessionId}|${dedupKey}`);
}

/**
 * FEA-1839: a deterministic event id for the `mutual_exclusivity_violation` row,
 * stable on `(harness, externalSessionId)` ONLY (no timestamp). Combined with
 * `INSERT ... ON CONFLICT (id) DO NOTHING`, this guarantees exactly one violation
 * row per harness session across re-detection and across process restarts.
 */
export function collectionViolationEventId(
  harness: string,
  externalSessionId: string
): string {
  return uuidV4FromInput(
    `mutual_exclusivity_violation|${harness}|${externalSessionId}`
  );
}

/** Deterministically derive a UUID-v4-shaped id from an arbitrary input string. */
function uuidV4FromInput(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    // biome-ignore lint/suspicious/noBitwiseOperators: UUID v4 variant bits require bitwise ops
    `${(0x8 | (Number.parseInt(hex[16]!, 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
