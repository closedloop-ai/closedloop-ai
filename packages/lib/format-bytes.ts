/**
 * ISS-8506: the one owner of byte-size formatting.
 *
 * Two implementations of `formatBytes` had grown independently — one in
 * `@repo/app`'s `shared/lib/format-utils.ts` and one in the desktop main
 * process's `agent-sync/agent-session-sync-service-helpers.ts` — and neither was
 * canonical. This module is that owner. Both call sites now delegate here, so
 * the next divergence is a diff in ONE file instead of a silent disagreement
 * between a log line and a screen.
 *
 * BOTH variants survive on purpose, and the reason is not indecision. They are
 * not label-variants of one function:
 *
 *  - {@link formatBinaryBytesWithDecimalLabels} is USER-FACING copy. It is
 *    null-aware (an unmeasured size must not be able to render as `0 B`),
 *    rounds with `Math.round(v * 10) / 10`, and tops out at GB.
 *  - {@link formatBinaryBytes} is main-process LOG copy. It is not null-aware,
 *    rounds with `.toFixed(1)`, and tops out at MiB.
 *
 * Collapsing them to one would either rewrite a dozen main-process log lines to
 * claim MB where they mean MiB, or change shipped user-facing onboarding copy —
 * neither of which belongs to a producer-lane ticket. Consolidating ownership
 * without changing either output is the whole win here: both delegations are
 * byte-identical to what they replaced, so every assertion already pinning them
 * stays green untouched.
 *
 * KNOWN INACCURACY, IN THE NAME rather than only in this comment: the
 * user-facing formatter divides by 1024 while labelling `KB`/`MB`/`GB` (1024 B
 * is 1 KiB). Correcting the OUTPUT would change numbers a user already reads,
 * so it belongs to the copy owner (ISS-8346 / ISS-8678), not to a producer-lane
 * ticket. What does belong here is not letting the quirk be the thing new code
 * reaches for by default, which a docstring cannot do and a name can: put
 * `formatBinaryBytesWithDecimalLabels` beside `formatBinaryBytes` and the
 * difference between them is visible at every call site.
 *
 * SO THERE IS NO CORRECT USER-FACING FORMATTER HERE YET, and that is deliberate
 * rather than an oversight. `formatBinaryBytes` is correct but is log copy - not
 * null-aware, and it tops out at MiB. Shipping a correct user-facing sibling now
 * would add an export with no caller, and the ticket that changes the copy is
 * the one that gets to introduce it.
 *
 * NOT folded in, named so a later reader does not think they were missed:
 * `@repo/app`'s `documents/lib/format-attachment-size.ts` (ceil-to-KB) and the
 * desktop's `shared/sync-burndown-contract.ts` `formatBurndownBytes` (a wire
 * contract). Both are separate consolidations.
 */

const BYTES_PER_STEP = 1024;
const DECIMAL_UNITS = ["B", "KB", "MB", "GB"] as const;

/** What a caller sees when it never measured a size at all. */
export const UNKNOWN_BYTE_SIZE_LABEL = "an unknown size";

/**
 * Human-readable byte size for USER-FACING copy, or
 * {@link UNKNOWN_BYTE_SIZE_LABEL} when the size was never measured.
 *
 * `null` is load-bearing: "we did not measure this" and "we measured zero" are
 * different facts, and rendering the first as `0 B` states a measurement that
 * was never taken.
 *
 * The post-division carry is not redundant with the loop. The loop stops while
 * the value is below 1024, and the rounding can then push it back onto an
 * invalid figure for that unit (`1_048_535` divides to `1023.96 KB`, which
 * rounds to `1024 KB`); the carry turns that into `1 MB`. That regression has
 * been shipped once already — see the cases in
 * `packages/app/shared/lib/__tests__/format-bytes.test.ts`.
 */
export function formatBinaryBytesWithDecimalLabels(
  bytes: number | null
): string {
  if (bytes == null) {
    return UNKNOWN_BYTE_SIZE_LABEL;
  }
  const lastUnitIndex = DECIMAL_UNITS.length - 1;
  let value = bytes;
  let unitIndex = 0;
  while (value >= BYTES_PER_STEP && unitIndex < lastUnitIndex) {
    value /= BYTES_PER_STEP;
    unitIndex += 1;
  }
  let rounded = unitIndex === 0 ? value : Math.round(value * 10) / 10;
  if (rounded >= BYTES_PER_STEP && unitIndex < lastUnitIndex) {
    rounded = Math.round((rounded / BYTES_PER_STEP) * 10) / 10;
    unitIndex += 1;
  }
  return `${rounded} ${DECIMAL_UNITS[unitIndex]}`;
}

/**
 * Human-readable byte size for main-process LOG lines, in binary units whose
 * labels match the divisor. Tops out at MiB because the values it describes are
 * batch and payload sizes, which never reach GiB.
 */
export function formatBinaryBytes(bytes: number): string {
  if (bytes < BYTES_PER_STEP) {
    return `${bytes} B`;
  }
  if (bytes < BYTES_PER_STEP * BYTES_PER_STEP) {
    return `${(bytes / BYTES_PER_STEP).toFixed(1)} KiB`;
  }
  return `${(bytes / (BYTES_PER_STEP * BYTES_PER_STEP)).toFixed(1)} MiB`;
}
