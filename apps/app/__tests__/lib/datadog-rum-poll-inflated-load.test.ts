import type { RumViewEvent } from "@datadog/browser-rum";
import { SESSIONS_ACTIVE_ROW_REFETCH_INTERVAL_MS } from "@repo/app/agents/lib/sessions-active-refetch";
import { describe, expect, it } from "vitest";
import { scrubDatadogRumEvent } from "@/lib/datadog-rum/config";
import {
  isPollInflatedLoadingTime,
  isPollInflatedLoadingType,
  POLL_INFLATED_LOADING_TIME_FLOOR_MS,
  RUM_POLL_INFLATED_LOAD_ATTRIBUTE,
} from "@/lib/datadog-rum/poll-inflated-load";
import { COMPUTE_TARGETS_POLL_INTERVAL_MS } from "@/lib/engineer/constants";

/**
 * The literals below are nanoseconds, written out rather than derived from the
 * floor, because a milliseconds/nanoseconds mix-up is the failure this file
 * exists to catch and a derived expectation would carry it.
 */
const SETTLED_VIEW_LOADING_TIME_NS = 4_930_000_000; // 4.93s — ISS-8794 §2
const POLLED_VIEW_LOADING_TIME_NS = 31_870_000_000; // 31.87s — ISS-8794 §2
const ISSUES_DETAIL_MEDIAN_LOADING_TIME_NS = 32_100_000_000; // 32.1s — AC1

function viewEvent(
  loadingTimeNs: number | undefined,
  // Spread rather than a defaulted `loadingType` string, so an ABSENT
  // `loading_type` is expressible: a default parameter also fires on an
  // explicitly-passed `undefined` and would silently restore `initial_load`.
  loadingTypeField: { loading_type?: RumViewEvent["view"]["loading_type"] } = {
    loading_type: "initial_load",
  }
) {
  return {
    type: "view",
    view: {
      id: "view-id",
      loading_time: loadingTimeNs,
      name: "/[orgSlug]/issues/[slug]",
      ...loadingTypeField,
    },
  };
}

describe("isPollInflatedLoadingTime", () => {
  it("reads its input as nanoseconds, not milliseconds", () => {
    // 30_000 nanoseconds is 0.03ms. Reading it as milliseconds would put it
    // exactly on the floor and report a 30-microsecond view as poll-inflated.
    expect(isPollInflatedLoadingTime(30_000)).toBe(false);
  });

  it.each([
    ["the ISS-8794 worked view", POLLED_VIEW_LOADING_TIME_NS],
    [
      "the /issues/[slug] median AC1 names",
      ISSUES_DETAIL_MEDIAN_LOADING_TIME_NS,
    ],
    ["a second poll cycle", 61_850_000_000],
  ])("treats %s as poll-inflated", (_label, loadingTimeNs) => {
    expect(isPollInflatedLoadingTime(loadingTimeNs)).toBe(true);
  });

  it.each([
    ["the same view's real settle point", SETTLED_VIEW_LOADING_TIME_NS],
    ["a slow but sub-poll load", 29_900_000_000],
    ["a fast load", 900_000_000],
  ])("leaves %s alone", (_label, loadingTimeNs) => {
    expect(isPollInflatedLoadingTime(loadingTimeNs)).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("does not classify an unusable value (%s)", (_label, loadingTimeNs) => {
    expect(isPollInflatedLoadingTime(loadingTimeNs)).toBe(false);
  });

  /**
   * The floor is copied out of the two fleet-wide 30s polls rather than
   * imported, so that copy needs a guard. Lowering either poll below the floor
   * would leave a cadence the floor no longer reaches. Shorter page-local polls
   * exist and are deliberately not covered — see the constant's own doc.
   */
  it("matches the two fleet-wide 30s poll cadences", () => {
    expect(POLL_INFLATED_LOADING_TIME_FLOOR_MS).toBe(
      Math.min(
        COMPUTE_TARGETS_POLL_INTERVAL_MS,
        SESSIONS_ACTIVE_ROW_REFETCH_INTERVAL_MS
      )
    );
  });
});

describe("scrubDatadogRumEvent view tagging", () => {
  it("tags a synthetic initial_load view carrying a poll-inflated loading_time", () => {
    const event = viewEvent(POLLED_VIEW_LOADING_TIME_NS);

    expect(scrubDatadogRumEvent(event as never)).toBe(true);
    expect(event).toMatchObject({
      context: { [RUM_POLL_INFLATED_LOAD_ATTRIBUTE]: true },
    });
  });

  it("tags a settled initial_load view as explicitly not inflated", () => {
    const event = viewEvent(SETTLED_VIEW_LOADING_TIME_NS);

    expect(scrubDatadogRumEvent(event as never)).toBe(true);
    expect(event).toMatchObject({
      context: { [RUM_POLL_INFLATED_LOAD_ATTRIBUTE]: false },
    });
  });

  it("keeps the view's own loading_time so a tagged view stays queryable", () => {
    const event = viewEvent(POLLED_VIEW_LOADING_TIME_NS);

    scrubDatadogRumEvent(event as never);

    expect(event.view.loading_time).toBe(POLLED_VIEW_LOADING_TIME_NS);
  });

  it("preserves context a caller already attached", () => {
    const event = {
      ...viewEvent(POLLED_VIEW_LOADING_TIME_NS),
      context: { range_days: "7" },
    };

    scrubDatadogRumEvent(event as never);

    expect(event.context).toEqual({
      range_days: "7",
      [RUM_POLL_INFLATED_LOAD_ATTRIBUTE]: true,
    });
  });

  /**
   * `view` is required on rum-core's `CommonProperties`, so a real resource
   * event carries it. Omitting it here would make dropping the `event.type`
   * check fail on a TypeError instead of on the tagging behaviour, while that
   * same mutation is harmless in prod (no `loading_time`, so no tag).
   */
  it("does not tag a non-view event that spans a poll", () => {
    const event = {
      type: "resource",
      resource: {
        duration: POLLED_VIEW_LOADING_TIME_NS,
        url: "https://api.closedloop.ai/agent-sessions",
      },
      view: {
        id: "view-id",
        referrer: "https://app.closedloop.ai/",
        url: "https://app.closedloop.ai/acme/agent-sessions",
      },
    };

    expect(scrubDatadogRumEvent(event as never)).toBe(true);
    expect(event).not.toHaveProperty("context");
  });

  it("tags a route_change carrying a poll-inflated loading_time", () => {
    const event = viewEvent(POLLED_VIEW_LOADING_TIME_NS, {
      loading_type: "route_change",
    });

    expect(scrubDatadogRumEvent(event as never)).toBe(true);
    expect(event).toMatchObject({
      context: { [RUM_POLL_INFLATED_LOAD_ATTRIBUTE]: true },
    });
  });

  /**
   * The isolating half of the pair above: widening the ratified set must not
   * also widen the floor. An edit that stopped reading
   * `isPollInflatedLoadingTime` and just wrote `true` for every ratified type
   * leaves the tagging case green and only this one red.
   */
  it("tags a route_change below the floor as explicitly not inflated", () => {
    const event = viewEvent(SETTLED_VIEW_LOADING_TIME_NS, {
      loading_type: "route_change",
    });

    expect(scrubDatadogRumEvent(event as never)).toBe(true);
    expect(event).toMatchObject({
      context: { [RUM_POLL_INFLATED_LOAD_ATTRIBUTE]: false },
    });
  });

  /**
   * Only `initial_load` waits for the browser load event, so a ratified
   * `route_change` can reach `beforeSend` with `loading_time` still
   * undefined (no post-start activity candidate). That view was never
   * measured, so it must stay ABSENT like an unratified type — not written
   * `false`, which the write's own contract reserves for a confirmed
   * under-floor measurement. An edit that gates only on `loading_type`
   * ratification (dropping the `isMeasuredLoadingTime` conjunct) leaves this
   * red while every other case in this file stays green.
   */
  it("leaves a route_change with no measured loading_time absent, not tagged false", () => {
    const event = viewEvent(undefined, { loading_type: "route_change" });

    expect(scrubDatadogRumEvent(event as never)).toBe(true);
    expect(event).not.toHaveProperty("context");
  });

  /**
   * The three states the write distinguishes, driven through the production
   * path in one case so no two of them can quietly collapse into each other:
   * `true` is evaluated-and-inflated, `false` is evaluated-and-confirmed-
   * under-floor, ABSENT is never-evaluated. An impossible `loading_time`
   * belongs in the third — writing it `false` would report a confirmed
   * under-floor load on a value that cannot be a load at all. The two tagged
   * rows are the positive control for the absent one: a change that stopped
   * writing anything would red them rather than pass this case.
   */
  it("keeps evaluated-true, evaluated-false and unusable distinguishable", () => {
    const inflated = viewEvent(POLLED_VIEW_LOADING_TIME_NS);
    const settled = viewEvent(SETTLED_VIEW_LOADING_TIME_NS);
    const impossible = viewEvent(0);

    for (const event of [inflated, settled, impossible]) {
      expect(scrubDatadogRumEvent(event as never)).toBe(true);
    }

    expect(inflated).toMatchObject({
      context: { [RUM_POLL_INFLATED_LOAD_ATTRIBUTE]: true },
    });
    expect(settled).toMatchObject({
      context: { [RUM_POLL_INFLATED_LOAD_ATTRIBUTE]: false },
    });
    expect(impossible).not.toHaveProperty("context");
  });

  /**
   * The whole impossible set for a nanosecond duration, not the two everyone
   * remembers (root `AGENTS.md`, "Handling Bad or Nonsensical Data"), on Marisol
   * Ashgrove's review of PR #7682. Zero and negative are not loads; rum-core
   * serializes with `round(durationMs * 1e6, 0)`, so a fractional or
   * out-of-safe-range count did not come through that path and cannot be read
   * as a duration either. Each stays ABSENT.
   *
   * Narrowing `isMeasuredLoadingTime` back to rejecting only non-number and
   * non-finite reds every row here and nothing else in this file. The first
   * four would be written an explicit `false`, each of them divides out below
   * the 30s floor; the last would be written an explicit `true`, because
   * 2**53 nanoseconds divides out to 104 days.
   */
  it.each([
    ["zero", 0],
    ["negative", -1_000_000],
    ["negative past the floor", -31_870_000_000],
    ["a fraction of a nanosecond", 4_930_000_000.5],
    ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 1],
  ])(
    "leaves an impossible loading_time (%s) absent, not tagged",
    (_label, loadingTimeNs) => {
      const event = viewEvent(loadingTimeNs);

      expect(scrubDatadogRumEvent(event as never)).toBe(true);
      expect(event).not.toHaveProperty("context");
    }
  );

  /**
   * `session_renewal` and `bf_cache` are the SDK's other two loading types and
   * are deliberately outside the ratified set — see
   * `POLL_INFLATED_LOAD_RATIFICATION`. They inflate by the same mechanism, so
   * nothing but the ratified set keeps them untagged, and an edit that widened
   * to "any loading type" would pass every other case in this file. These stay
   * ABSENT rather than explicit `false`, unlike the ratified-and-settled cases
   * above — the classifier never evaluated them.
   */
  it.each([
    ["session_renewal", { loading_type: "session_renewal" }],
    ["bf_cache", { loading_type: "bf_cache" }],
    ["a view with no loading_type", {}],
  ] as const)(
    "leaves %s carrying the same loading_time untagged",
    (_label, loadingTypeField) => {
      const event = viewEvent(POLLED_VIEW_LOADING_TIME_NS, loadingTypeField);

      expect(scrubDatadogRumEvent(event as never)).toBe(true);
      expect(event).not.toHaveProperty("context");
    }
  );
});

/**
 * The four values enumerated here are the ones rum-core 7.2.0 can emit in a
 * BROWSER (`ViewLoadingType` in `rawRumEvent.types.d.ts`); the wire union the
 * predicate is typed against carries six more that only a mobile SDK sends.
 * A NEW loading type is caught by `POLL_INFLATED_LOAD_RATIFICATION`'s
 * annotation at `tsc`, not here — this table pins the four classifications that
 * annotation cannot state.
 */
describe("isPollInflatedLoadingType", () => {
  it.each([
    ["initial_load", true],
    ["route_change", true],
    ["session_renewal", false],
    ["bf_cache", false],
  ] as const)(
    "ratifies the SDK loading type %s as %s",
    (loadingType, ratified) => {
      expect(isPollInflatedLoadingType(loadingType)).toBe(ratified);
    }
  );

  it("does not ratify an absent loading_type", () => {
    expect(isPollInflatedLoadingType(undefined)).toBe(false);
  });

  /**
   * A mobile-only value: unreachable from this SDK, but inside the union the
   * predicate is typed against, so it is the one arm the four-row table above
   * cannot reach.
   */
  it("does not ratify a mobile-only loading type", () => {
    expect(isPollInflatedLoadingType("view_controller_display")).toBe(false);
  });
});
