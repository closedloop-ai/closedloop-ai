import {
  SESSION_DATE_FROM_PARAM,
  SESSION_DATE_TO_PARAM,
} from "@repo/app/agents/lib/session-custom-date-window";
import { SESSION_FACET_FILTER_PARAMS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionStatusFacetValue } from "@repo/app/agents/lib/session-status-filters";
import { SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableSessionsPageFeatureFlag,
  mockSessionsPageEmptyState,
  navigationReplaceMock,
  resetSessionsPageTestState,
  setSessionsFacetQuery,
  setSessionsPageQuery,
  setSessionsTotal,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

/**
 * ISS-9822 — the HOST half of the explicit `?from=`/`?to=` window on the v2
 * surface, and the sibling of `v2-owner-scope-url-seam.test.tsx`, which pins the
 * same seam for `?userId=`.
 *
 * FEA-4201 gave this page the window: it parses the params, gates them, and
 * feeds the bounds to both reads. The v2 host then mounted `SessionsListSurfaceV2`
 * without `customDateWindow` or `onCustomDateWindowChange`, so the reader got a
 * listing narrowed by an interval with no control naming it, no count of it as a
 * narrower — `filtersActive` reads the window off that prop alone, so a window
 * was the one narrower that offered no "Clear all" at all — and, when a facet did
 * offer one, a clear that left `?from=`/`?to=` standing while desktop stripped
 * them.
 *
 * The clear is why the sequencing cases read EVERY write rather than the last.
 * `ActiveFiltersBar`'s "Clear all" fires `clearAllFilters()` and then one
 * `onToggle` per still-selected value SYNCHRONOUSLY, all off the same pre-click
 * search-params snapshot, so the defect being fixed is precisely a LATER write
 * restoring what an earlier one removed.
 */

const WINDOW_FROM = "2026-01-01";
const WINDOW_TO = "2026-01-08";

const STATUS_PARAM = SESSION_FACET_FILTER_PARAMS.statuses;

const CLEAR_ALL_LABEL = "Clear all";

/**
 * The control's accessible name is stable and states what the control IS; the
 * window it holds is appended. Matched by prefix rather than by re-deriving the
 * formatted dates from the module under test, which would make the assertion
 * agree with any formatting it happened to produce.
 */
const CUSTOM_RANGE_TRIGGER = /^Custom date range:/;

/** The X beside the trigger — the "and its clear" half of the capability. */
const CUSTOM_RANGE_CLEAR = /^Clear custom date range/;

/** The unwindowed trigger, which reads "Custom" and carries no window. */
const CUSTOM_RANGE_ANY = /^Custom/;

/**
 * The two calendar days the PICK case presses. Pinned literals against a pinned
 * clock, never re-derived from the encoder under test — the duplication is what
 * lets the assertion fail.
 */
const JANUARY_5_DAY_NAME = /January 5/;
const JANUARY_12_DAY_NAME = /January 12/;
const PICKED_FROM = "2026-01-05";
const PICKED_TO = "2026-01-12";

/** Deep enough that the stale-page clamp leaves page 4 alone. */
const LATER_PAGE = "4";
const LATER_PAGE_TOTAL = 240;

/** jsdom reports zero width, which folds the toolbar to its compact menus. */
let restoreContainerWidth: (() => void) | null = null;

function seedWindow() {
  setSessionsFacetQuery(SESSION_DATE_FROM_PARAM, [WINDOW_FROM]);
  setSessionsFacetQuery(SESSION_DATE_TO_PARAM, [WINDOW_TO]);
}

function renderWindowedV2Page({
  activeWindow = true,
  windowGate = true,
}: {
  activeWindow?: boolean;
  windowGate?: boolean;
} = {}) {
  restoreContainerWidth = stubContainerWidthPx(1440);
  if (windowGate) {
    enableSessionsPageFeatureFlag(SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY);
  }
  if (activeWindow) {
    seedWindow();
  }
  return render(<SessionsPage />, { wrapper: SessionsPageTestProviders });
}

/** Every URL this click wrote, oldest first. */
function writtenUrls(): string[] {
  return navigationReplaceMock.mock.calls.map((call) => String(call[0]));
}

describe("Sessions page — v2 custom date window URL seam", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
    localStorage.clear();
  });

  afterEach(() => {
    restoreContainerWidth?.();
    restoreContainerWidth = null;
    // Unconditional, and in the hook rather than at the end of the case that
    // installs them: an assertion that throws between would otherwise leave a
    // frozen clock in this worker and redden every later case in the file.
    vi.useRealTimers();
  });

  it("renders the Custom range control and its clear for an active window", () => {
    renderWindowedV2Page();

    expect(screen.getByLabelText(CUSTOM_RANGE_TRIGGER)).toBeInTheDocument();
    expect(screen.getByLabelText(CUSTOM_RANGE_CLEAR)).toBeInTheDocument();
  });

  it("strips the window when the control's own clear is used", () => {
    // The other clear, and a DIFFERENT route through the seam: the X reports the
    // window change and then a view change that moved nothing else, where "Clear
    // all" arrives with the facets moving too. A control that renders but whose
    // clear reaches no URL is the same lie as no control at all.
    renderWindowedV2Page();

    navigationReplaceMock.mockClear();
    fireEvent.click(screen.getByLabelText(CUSTOM_RANGE_CLEAR));

    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain(`${SESSION_DATE_FROM_PARAM}=`);
      expect(url).not.toContain(`${SESSION_DATE_TO_PARAM}=`);
    }
  });

  it("counts the window as a narrower, so Clear all is offered by itself", () => {
    // No facet is seeded: the window is the ONLY narrower. Pre-fix the surface
    // was never handed it, `filtersActive` read false, and the chip row that
    // carries "Clear all" never mounted — so the one narrower in force was also
    // the one with no way out.
    renderWindowedV2Page();

    expect(
      screen.getByRole("button", { name: CLEAR_ALL_LABEL })
    ).toBeInTheDocument();
  });

  it("reads a windowed-away v2 list as filtered rather than genuinely empty", () => {
    mockSessionsPageEmptyState("organization");
    renderWindowedV2Page();

    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    expect(screen.queryByText("No sessions yet")).toBeNull();
  });

  it("strips ?from= and ?to= in every write Clear all makes, alongside the facets", () => {
    setSessionsFacetQuery(STATUS_PARAM, [SessionStatusFacetValue.Active]);
    renderWindowedV2Page();

    navigationReplaceMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: CLEAR_ALL_LABEL }));

    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain(`${SESSION_DATE_FROM_PARAM}=`);
      expect(url).not.toContain(`${SESSION_DATE_TO_PARAM}=`);
      expect(url).not.toContain(`${STATUS_PARAM}=`);
    }
  });

  it("keeps a window PICKED from a later page, in one write", async () => {
    // The other direction, from the only page where it is visible. Every case
    // above CLEARS, and every one of them runs at page 0 — where `next.page`
    // already equals the current index and the trailing `replacePage` never
    // fires. From page 4 it does fire, right after the pick's own write, and it
    // rebuilds from the same pre-click search-params snapshot with no window
    // params on it: the URL that landed put the reader on page 1 with the range
    // they had just chosen silently gone, and nothing on screen said so.
    //
    // No inbound window is seeded on purpose. With one, that second write copies
    // `?from=`/`?to=` back out of the pre-click snapshot and the clobber is
    // invisible — the case would pass against the defect it is here to catch.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setSessionsTotal(LATER_PAGE_TOTAL);
    setSessionsPageQuery(LATER_PAGE);
    renderWindowedV2Page({ activeWindow: false });

    navigationReplaceMock.mockClear();
    await user.click(screen.getByRole("button", { name: CUSTOM_RANGE_ANY }));
    await user.click(
      await screen.findByRole("button", { name: JANUARY_5_DAY_NAME })
    );
    await user.click(screen.getByRole("button", { name: JANUARY_12_DAY_NAME }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    // EVERY write, for the reason the clear cases above read them all: it is a
    // LATER write landing WITHOUT the window that is the defect, so asserting
    // the first one alone stays green while the URL the reader ends on has no
    // `?from=` on it.
    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toContain(`${SESSION_DATE_FROM_PARAM}=${PICKED_FROM}`);
      expect(url).toContain(`${SESSION_DATE_TO_PARAM}=${PICKED_TO}`);
    }
    // And ONE of them, which is the rule this seam is built on rather than an
    // incidental count: the pick already carried its own page reset, so a second
    // write here could only be that reset happening again from the pre-click
    // params — the shape that drops the window whether or not it is caught above.
    expect(urls).toHaveLength(1);
  });

  it("strips the window when it is the only narrower Clear all has to move", () => {
    // The no-other-axis case: the window is the only narrower "Clear all" has
    // to move, and the click must still reach the URL — otherwise the chip row
    // disappears and the list stays narrowed by a window nothing is naming any
    // more. It rides the router's OWN delta even so: the surface rebuilds its
    // facets object, so a delta is reported with nothing selected. This case
    // therefore does not cover the synthesized no-delta write — the Custom
    // control's own clear above is the only path that does.
    renderWindowedV2Page();

    navigationReplaceMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: CLEAR_ALL_LABEL }));

    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain(`${SESSION_DATE_FROM_PARAM}=`);
      expect(url).not.toContain(`${SESSION_DATE_TO_PARAM}=`);
    }
  });
});

/**
 * ISS-4779 closed-by-default: with `sessions-custom-date-window` shut, this whole
 * capability is byte-for-byte what shipped before. The page gates its handler to
 * `undefined`, the fold withholds the surface callback, the toolbar keys the
 * Custom control off that callback's presence, and no clear is ever pending — so
 * a scope write leaves an inbound window exactly where it found it.
 */
describe("Sessions page — v2 custom date window with the gate closed", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
    localStorage.clear();
  });

  afterEach(() => {
    restoreContainerWidth?.();
    restoreContainerWidth = null;
  });

  it("offers no Custom control", () => {
    renderWindowedV2Page({ windowGate: false });

    expect(screen.queryByLabelText(CUSTOM_RANGE_ANY)).toBeNull();
    expect(screen.queryByRole("button", { name: CUSTOM_RANGE_ANY })).toBeNull();
  });

  it("leaves ?from= and ?to= standing through Clear all", () => {
    setSessionsFacetQuery(STATUS_PARAM, [SessionStatusFacetValue.Active]);
    renderWindowedV2Page({ windowGate: false });

    navigationReplaceMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: CLEAR_ALL_LABEL }));

    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toContain(`${SESSION_DATE_FROM_PARAM}=${WINDOW_FROM}`);
      expect(url).toContain(`${SESSION_DATE_TO_PARAM}=${WINDOW_TO}`);
      expect(url).not.toContain(`${STATUS_PARAM}=`);
    }
  });
});
