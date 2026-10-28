import "server-only";

import type { DeliveryPointWindow } from "./delivery-point-attribution";

/**
 * A request's date window, in the shape both Branches entry points carry.
 *
 * `unknown` rather than a union because the two entry points parse these
 * differently and both are legal here: `/branches/analytics` coerces to `Date`
 * (`branch-list-query.ts:166`), while the cohort POST keeps the ISO string
 * (`branch-analytics-cohort.ts:42`). {@link penseroDeliveryWindow} narrows both.
 */
export type PenseroDateWindowQuery = {
  readonly startDate?: unknown;
  readonly endDate?: unknown;
};

/**
 * The delivery window a request asks for, or `undefined` for the all-time view.
 *
 * Both bounds are read independently: a half-open window narrows the
 * denominator just as a closed one does, so an "up to this date" view gets its
 * numerator bounded on the same side its cost basis is.
 *
 * A bound this cannot turn into a real instant is dropped rather than guessed,
 * which widens the numerator's period to the denominator's own unbounded side
 * on that axis. It is unreachable from every production caller — each passes
 * validated or projected instants — and is stated because the parameter type
 * is `unknown`.
 */
export function penseroDeliveryWindow(
  query: PenseroDateWindowQuery
): DeliveryPointWindow | undefined {
  const start = asInstant(query.startDate);
  const end = asInstant(query.endDate);
  if (start === undefined && end === undefined) {
    return undefined;
  }
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

/** One request bound as an instant, or `undefined` when it names none. */
function asInstant(bound: unknown): Date | undefined {
  if (bound instanceof Date) {
    return Number.isFinite(bound.getTime()) ? bound : undefined;
  }
  if (typeof bound !== "string") {
    return undefined;
  }
  const parsed = Date.parse(bound);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}
