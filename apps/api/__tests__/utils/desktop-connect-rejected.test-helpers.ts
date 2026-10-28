/**
 * ISS-6343: shared reader for the `desktop_connect_rejected` line the
 * browser-facing desktop-connect routes emit at every rejection branch.
 *
 * Returns the whole observation as one comparable object so a route suite can
 * pin it with a single `expect`, including `fieldKeys` — an absent `orgId` must
 * be omitted, not set to `undefined`, and `toEqual` alone would not catch that.
 * The expected event name and fields stay in the suites, written independently
 * of `@/app/desktop/contract`, so a renamed event reddens them.
 */
import type { Mock } from "vitest";

export type DesktopConnectRejection = {
  warnCallCount: number;
  event: string | undefined;
  fields: object | undefined;
  fieldKeys: string[];
};

export function readDesktopConnectRejection(
  warn: Mock
): DesktopConnectRejection {
  const [event, fields] = (warn.mock.calls[0] ?? []) as [
    string | undefined,
    object | undefined,
  ];
  return {
    warnCallCount: warn.mock.calls.length,
    event,
    fields,
    fieldKeys: fields ? Object.keys(fields).sort() : [],
  };
}

/**
 * The expected observation for a branch that reported exactly `fields`.
 *
 * `occurrences: 1` rides on every single occurrence so `sum(occurrences)` over
 * the event is the true total: a suppressed burst reaches Datadog as ONE rollup
 * line carrying its own count, and a query that summed only rollups would miss
 * every first occurrence.
 */
export function oneDesktopConnectRejection(fields: {
  reason: string;
  stage: string;
  orgId?: string;
  cause?: string;
}): DesktopConnectRejection {
  const reported = { ...fields, occurrences: 1 };
  return {
    warnCallCount: 1,
    event: "desktop_connect_rejected",
    fields: reported,
    fieldKeys: Object.keys(reported).sort(),
  };
}
