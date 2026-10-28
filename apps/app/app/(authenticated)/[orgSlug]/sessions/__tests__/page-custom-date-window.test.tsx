import {
  SESSION_DATE_FROM_PARAM,
  SESSION_DATE_TO_PARAM,
} from "@repo/app/agents/lib/session-custom-date-window";
import { SESSION_DATE_RANGE_PARAM } from "@repo/app/agents/lib/session-date-range-param";
import { SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enableSessionsPageFeatureFlag,
  holdSessionsFeatureFlagResolution,
  lastSessionsTableCallArgs,
  lastSessionsTableCallOptions,
  resetSessionsPageTestState,
  setSessionsFacetQuery,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

/**
 * FEA-4201. The lib suite proves the codec in isolation; this proves the PAGE
 * reads it — that `?from=`/`?to=` reach the query the list actually issues.
 *
 * The assertion is on the EMITTED QUERY, never on the URL: a URL assertion alone
 * stays green while the page ignores the params entirely, which is exactly the
 * failure a drill-down link would produce.
 *
 * The expected bounds are pinned literals rather than a call to the module's own
 * bounds helper. Deriving them from the encoder under test would make the test
 * agree with any encoding it happened to produce, including a wrong one.
 */
describe("sessions page custom from/to window (FEA-4201)", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
  });

  afterEach(() => {
    localStorage.clear();
    // The browser URL is real global state in jsdom; a test that seeds it must
    // put it back or the next one inherits a window it never asked for.
    globalThis.history.replaceState({}, "", "/acme/sessions");
  });

  it("bounds a single-day drill-down at BOTH ends", () => {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
    setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, ["2026-01-01"]);
    setSessionsFacetQuery(SESSION_DATE_TO_PARAM, ["2026-01-01"]);

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(lastSessionsTableCallArgs()).toMatchObject({
      endDate: "2026-01-01T23:59:59.999Z",
      startDate: "2026-01-01T00:00:00.000Z",
    });
  });

  it("bounds a multi-day window at BOTH ends", () => {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
    setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, ["2026-01-01"]);
    setSessionsFacetQuery(SESSION_DATE_TO_PARAM, ["2026-01-08"]);

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(lastSessionsTableCallArgs()).toMatchObject({
      endDate: "2026-01-08T23:59:59.999Z",
      startDate: "2026-01-01T00:00:00.000Z",
    });
  });

  /**
   * The explicit interval supersedes the rolling preset. Sending BOTH is what a
   * detail→back can present (the preset is written by the range picker, the
   * interval by a drill-down), so the precedence has to be observable rather
   * than incidental — a `?range=90d` lower bound is 90 days before today, which
   * no fixed literal could be mistaken for.
   */
  it("lets the explicit window win over an inbound ?range= preset", () => {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
    setSessionsFacetQuery(SESSION_DATE_RANGE_PARAM, ["90d"]);
    setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, ["2026-01-01"]);
    setSessionsFacetQuery(SESSION_DATE_TO_PARAM, ["2026-01-01"]);

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(lastSessionsTableCallArgs()).toMatchObject({
      endDate: "2026-01-01T23:59:59.999Z",
      startDate: "2026-01-01T00:00:00.000Z",
    });
  });

  /**
   * ISS-4779 closed-by-default. With the gate off the params must be INERT, not
   * merely un-offered: a link written by a build that has the flag on would
   * otherwise narrow a listing whose viewer has no control to see or clear it.
   */
  it("ignores the params entirely with the gate off", () => {
    setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, ["2026-01-01"]);
    setSessionsFacetQuery(SESSION_DATE_TO_PARAM, ["2026-01-01"]);

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    const args = lastSessionsTableCallArgs();
    expect(args?.startDate).not.toBe("2026-01-01T00:00:00.000Z");
    expect(args?.endDate).not.toBe("2026-01-01T23:59:59.999Z");
  });

  /**
   * An inverted window has no rows. Falling back to the preset is the safe
   * degradation; applying it would render an empty list with nothing on screen
   * explaining why.
   */
  it("falls back to the preset for an inverted window", () => {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
    setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, ["2026-01-08"]);
    setSessionsFacetQuery(SESSION_DATE_TO_PARAM, ["2026-01-01"]);

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    const args = lastSessionsTableCallArgs();
    expect(args?.startDate).not.toBe("2026-01-08T00:00:00.000Z");
    expect(args?.endDate).not.toBe("2026-01-01T23:59:59.999Z");
  });

  it("falls back to the preset when only one bound is present", () => {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
    setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, ["2026-01-01"]);

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(lastSessionsTableCallArgs()?.startDate).not.toBe(
      "2026-01-01T00:00:00.000Z"
    );
  });

  /**
   * FEA-4201 (whitlockk review). PostHog reports every flag as `false` until it
   * answers, and `false` here is indistinguishable from "off" — so a flagged
   * `?from=`/`?to=` link read the PRESET window first, painted rows and summary
   * figures for a window nobody asked for, and only refetched the requested one
   * once the flag resolved.
   *
   * The read is HELD, not merely re-issued later: `enabled` false is the only
   * observable difference, because a held read is still called with the filters
   * it would use.
   */
  it("holds the read while the gate is still unresolved", () => {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
    holdSessionsFeatureFlagResolution(
      SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY
    );
    setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, ["2026-01-01"]);
    setSessionsFacetQuery(SESSION_DATE_TO_PARAM, ["2026-01-01"]);

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(lastSessionsTableCallOptions()?.enabled).toBe(false);
  });

  /**
   * And the wait is SCOPED to the URLs it can change the answer for. An
   * unresolved flag cannot move the window of a URL that names none, so an
   * ordinary Sessions visit — every listing without `?from=`/`?to=` — must not
   * pay a flag round-trip before its first read. Without this, the gate above
   * would be satisfied by delaying every visit.
   */
  it("does not hold an ordinary visit that names no window", () => {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
    holdSessionsFeatureFlagResolution(
      SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY
    );

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(lastSessionsTableCallOptions()?.enabled).toBe(true);
  });

  /**
   * FEA-4201 (codex review). On a web reload or deep link the App Router's
   * search-params snapshot can still be reconciling — and therefore EMPTY — on
   * the first client render. The facet seed beside this already guards that gap
   * with `initialFacetParamsSource`; the window did not, so the first enabled
   * list and summary read used the saved rolling preset and only switched to the
   * requested bounds after reconciliation: wrong rows, wrong metrics, and an
   * extra request.
   *
   * The snapshot is left EMPTY here on purpose. That is the hydration gap.
   */
  it("reads the requested window while the router snapshot is still empty", () => {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
    // ISS-8187: the seeded address bar must be the route this page is mounted
    // at (`resetSessionsPageTestState("organization")` puts it on
    // `/acme/sessions`). The browser-URL fallback is now scoped to its own
    // route, so a bar pointing somewhere else is not the hydration gap — it is
    // the cross-surface leak, and it is meant to be ignored.
    globalThis.history.replaceState(
      {},
      "",
      "/acme/sessions?from=2026-01-01&to=2026-01-01"
    );

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(lastSessionsTableCallArgs()).toMatchObject({
      endDate: "2026-01-01T23:59:59.999Z",
      startDate: "2026-01-01T00:00:00.000Z",
    });
  });

  /**
   * And the fallback must not outlive the gap. Unlike the facet seed — a
   * one-time `useState` initializer — this window is derived on EVERY render, so
   * a browser-URL read that never stopped would resurrect a window the user had
   * just cleared: clearing empties the snapshot legitimately, and `location`
   * lags it. The fallback is latched off once the snapshot has proven
   * authoritative.
   */
  it("does not resurrect a cleared window from a lagging browser URL", () => {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
    setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, ["2026-01-01"]);
    setSessionsFacetQuery(SESSION_DATE_TO_PARAM, ["2026-01-01"]);
    // ISS-8187: the seeded address bar must be the route this page is mounted
    // at (`resetSessionsPageTestState("organization")` puts it on
    // `/acme/sessions`). The browser-URL fallback is now scoped to its own
    // route, so a bar pointing somewhere else is not the hydration gap — it is
    // the cross-surface leak, and it is meant to be ignored.
    globalThis.history.replaceState(
      {},
      "",
      "/acme/sessions?from=2026-01-01&to=2026-01-01"
    );

    const { rerender } = render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });
    // The window is cleared in the snapshot the page reads, while the browser URL
    // has not caught up yet — the exact skew the latch exists for.
    setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, []);
    setSessionsFacetQuery(SESSION_DATE_TO_PARAM, []);
    rerender(<SessionsPage />);

    const args = lastSessionsTableCallArgs();
    expect(args?.startDate).not.toBe("2026-01-01T00:00:00.000Z");
    expect(args?.endDate).not.toBe("2026-01-01T23:59:59.999Z");
  });
});
