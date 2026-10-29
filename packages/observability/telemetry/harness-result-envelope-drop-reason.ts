/**
 * @file harness-result-envelope-drop-reason.ts
 * @description ISS-7332 — why the desktop dropped a persisted raw harness result
 * envelope on load.
 *
 * Its own module rather than another block in `schema.ts`, which sits at the
 * 1,000-line ceiling and is NOT grandfathered: adding a fourth reason vocabulary
 * inline would push it over (see AGENTS.md → "File Size and Organization").
 * This module owns the finished validator too, so `schema.ts` spends one line on
 * the family instead of seven — the same shape as its sibling
 * `db-host-telemetry-refusal-reason.ts`. Nothing is re-exported from `schema.ts`,
 * so consumers import the reason directly from this path.
 *
 * Bounded and content-free by construction: it names the FAILURE MODE only,
 * never a loop id, a work dir, or any part of the envelope — the envelope's own
 * `result` field carries the run's final assistant text.
 *
 * The desktop mirror is `HarnessResultEnvelopeDropReason` in
 * `apps/desktop/src/main/telemetry/telemetry-protocol.ts`, declared there with no
 * shared import from this module — so a value only the producer knows about is
 * rejected by `desktopTelemetryEventSchema`, which drops the WHOLE event as
 * `telemetry.validation_failed`. A new reason MUST be added here in the same
 * change.
 */

import { z } from "zod";

export const HarnessResultEnvelopeDropReason = {
  /**
   * The persisted row did not satisfy the retained-envelope schema. The local
   * JSON store is a parse boundary — a partial write, a hand edit, or a shape
   * another build wrote all land here — and the row can no longer be re-parsed
   * into the authoritative cost it existed to preserve.
   */
  CorruptPersistedRow: "corrupt_persisted_row",
} as const;

export type HarnessResultEnvelopeDropReason =
  (typeof HarnessResultEnvelopeDropReason)[keyof typeof HarnessResultEnvelopeDropReason];

/**
 * The `diagnostics.harnessResultEnvelopesDropped` validator.
 *
 * `count` is POSITIVE, not merely non-negative: a drop report that says zero
 * describes a drop that did not happen, and rejecting it here is how a producer
 * that increments its tally outside the branch where the drop actually occurred
 * becomes visible instead of quietly inflating the alert.
 */
export const harnessResultEnvelopesDroppedDiagnosticsSchema = z
  .object({
    reason: z.enum(Object.values(HarnessResultEnvelopeDropReason)),
    count: z.number().int().positive(),
  })
  .strip()
  .optional();
