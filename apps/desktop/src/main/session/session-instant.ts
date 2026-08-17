/**
 * How the desktop LOCAL session producer reads a stored timestamp string.
 *
 * Split out of `shared-agent-sessions-api.ts` (ISS-6455) because the two
 * readings answer different questions and the difference is load-bearing — the
 * distinction was invisible while both sat mid-file in a 1,500-line module that
 * the grandfather list keeps shrink-only.
 */

/**
 * A REQUIRED instant, floored at epoch 0 when the stored string is unparseable.
 *
 * The floor is an ORDERING device, not a claim: a row with a malformed
 * `started_at` still sorts and still falls inside a date window rather than
 * vanishing from the page. The SQL side mirrors it deliberately
 * (`sync-source.ts`, `session-date-window.ts`), so the two must stay in step.
 */
export function parseSessionDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date(0);
  }
  return date;
}

/**
 * A NULLABLE instant — `null` when the stored string is absent OR unparseable.
 *
 * ISS-6455 (wongk, #5099 review): deliberately NOT {@link parseSessionDate}'s
 * epoch floor. `ended_at` says whether the run is over and `awaiting_input_since`
 * says whether it is blocked on a human, and epoch 0 answers both with a
 * confident, wrong "yes, in 1970". That is the fabricated instant the display
 * tri-state (`packages/app/agents/lib/session-displayed-status-with-waiting.ts`)
 * refuses to time a run on — and because this producer coerced first, the guard
 * could never see it for the desktop-local population that ticket is about.
 *
 * A nullable field already has a representation for "no usable value", so it
 * uses it. Callers read `null` as absent, which is the honest reading.
 */
export function parseNullableSessionDate(
  value: string | null | undefined
): Date | null {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}
