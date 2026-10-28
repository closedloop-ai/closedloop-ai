/**
 * Calendar days of the PREVIOUS month, for the Sessions date-window specs.
 *
 * Previous rather than CURRENT is the load-bearing part: a window ending
 * mid-month would otherwise have to reason about whether the runner's own day
 * falls inside it, a seed dated later than "now" is a state the local corpus
 * never really holds, and a day cell in the future is not clickable at all.
 *
 * Every reading is UTC, so a spec that CLICKS the picker has to pin the app to
 * `TZ=UTC` — the control passes no `defaultMonth` and opens on the app's LOCAL
 * month, which disagrees with these for the hours when the two calendars
 * differ. Both callers do; see the TZ note in `sessions-custom-date-window.spec.ts`.
 */

/** One capture of the previous month, and days derived from THAT capture. */
export type PreviousMonthDays = {
  /** A day of the captured month as the `YYYY-MM-DD` the params carry. */
  isoDay: (day: number) => string;
  /** The captured month, as a `YYYY-MM` prefix. */
  prefix: string;
};

/**
 * Read the clock ONCE and hand back every day derived from that reading.
 *
 * Call it at the top of a test and take the seeds, the clicked cells and the
 * URL expectations from the same object. Re-reading the clock per value is what
 * this replaces: one desktop test spans two app launches and a migration, so a
 * run crossing UTC midnight on the 1st could seed one month, click a cell in
 * another and assert a third — three values that were only ever meant to be one.
 *
 * It does not, and cannot, pin the APP's clock: the picker opens on the app's
 * current month and both callers navigate exactly one page back, so a rollover
 * between this capture and that click still lands on the wrong month. That
 * residue is one instant a month and needs the app's own calendar to close;
 * what this closes is the test's disagreement with itself, which is every other
 * instant of the run.
 */
export function capturePreviousMonthDays(): PreviousMonthDays {
  const now = new Date();
  const previous = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const month = String(previous.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `${previous.getUTCFullYear()}-${month}`;
  return {
    isoDay: (day: number) => `${prefix}-${String(day).padStart(2, "0")}`,
    prefix,
  };
}
