import { SESSION_FACET_FILTER_PARAMS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionStatusFacetValue } from "@repo/app/agents/lib/session-status-filters";
import { SESSIONS_PROJECT_FACET_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enableSessionsPageFeatureFlag,
  lastSessionsTableCallArgs,
  mockSessionsPageEmptyState,
  navigationReplaceMock,
  resetSessionsPageTestState,
  setSelectedSessionUser,
  setSessionsFacetQuery,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

/**
 * ISS-8037 — the HOST half of the `?userId=` owner scope on the v2 surface.
 *
 * #6026 made the scope a view-state axis: `SessionsListSurfaceV2` chips it,
 * counts it in `filtersActive`, and clears it inside "Clear all". None of that
 * reached a reader, because the v2 host pinned the axis to `null` — so a
 * `?userId=`-scoped list still rendered as a genuinely empty org, with no chip
 * and no way out short of editing the URL.
 *
 * The seam these cases pin is why that was deferred rather than wired. The
 * removal is a URL PARAM STRIP, not a facet write, so it cannot ride the facet
 * writer; and it cannot be a second host callback either, because
 * `ActiveFiltersBar`'s "Clear all" fires `clearAllFilters()` then one `onToggle`
 * per still-selected value SYNCHRONOUSLY. Every one of those re-enters the
 * page's writer from the SAME pre-click search-params snapshot, so a strip that
 * did not ride the facet write would be re-asserted by the next write in the
 * same click. Carrying the scope as an axis of `SessionsHostViewState` is what
 * puts the strip inside that one `replaceListParams` call.
 *
 * Which is why the two sequencing cases read EVERY write rather than the last:
 * the defect these replace is precisely a LATER write putting `?userId=` back.
 */

const SCOPED_USER_ID = "user-123";

/**
 * The v2 chip row labels one chip per active facet GROUP, from that group's own
 * options. The page's roster and usage reads are stubbed empty here, so the
 * scope resolves to no display name and the chip wears the raw id — the
 * documented last-resort label, and still the value narrowing the list.
 */
const SCOPE_CHIP_REMOVE_LABEL = `Remove Owner: ${SCOPED_USER_ID} filter`;

const CLEAR_ALL_LABEL = "Clear all";

/**
 * The page-owned scope param. Non-exported in `page.tsx` (an App Router page
 * module may only carry the reserved exports), so this spec redeclares the
 * literal exactly as its siblings in this directory do. The FACET params come
 * from their canonical map instead, because that one IS exported.
 */
const SELECTED_USER_PARAM = "userId";

const STATUS_PARAM = SESSION_FACET_FILTER_PARAMS.statuses;

const OWNER_FACET_PARAM = SESSION_FACET_FILTER_PARAMS.userIds;

const PROJECT_FACET_PARAM = SESSION_FACET_FILTER_PARAMS.projectIds;

const SCOPED_PROJECT_ID = "project-abc";

/** Any owner-scope chip's remove control, whatever value it wears. */
const ANY_SCOPE_CHIP_REMOVE = /^Remove Owner:/;

/** jsdom reports zero width, which folds the toolbar to its compact menus. */
let restoreContainerWidth: (() => void) | null = null;

function renderScopedV2Page() {
  restoreContainerWidth = stubContainerWidthPx(1440);
  setSelectedSessionUser(SCOPED_USER_ID);
  return render(<SessionsPage />, { wrapper: SessionsPageTestProviders });
}

/** Every URL this click wrote, oldest first. */
function writtenUrls(): string[] {
  return navigationReplaceMock.mock.calls.map((call) => String(call[0]));
}

describe("Sessions page — v2 owner-scope URL seam", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
    localStorage.clear();
  });

  afterEach(() => {
    restoreContainerWidth?.();
    restoreContainerWidth = null;
  });

  it("names the ?userId= scope with a removable chip on the v2 surface", () => {
    renderScopedV2Page();

    // The chip row only mounts when the surface's `filtersActive` is true, so
    // the chip's presence IS the count: pre-fix the host reported no scope, the
    // surface counted no narrowing, and no chip row existed to name one.
    expect(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL)).toBeInTheDocument();
    // And the scope is really narrowing the read the chip claims to describe —
    // otherwise the chip would name a filter that changes nothing, and stripping
    // the param would widen nothing.
    expect(lastSessionsTableCallArgs()).toMatchObject({
      userId: SCOPED_USER_ID,
    });
  });

  it("shows no scope chip on an unscoped v2 mount", () => {
    // The negative sibling for the case above, on the same surface: without it
    // "the chip is there" could pass on a row that chips every mount, and the
    // read assertion could pass on a page that always sends `userId`.
    restoreContainerWidth = stubContainerWidthPx(1440);
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(screen.queryByLabelText(SCOPE_CHIP_REMOVE_LABEL)).toBeNull();
    expect(screen.queryByRole("button", { name: CLEAR_ALL_LABEL })).toBeNull();
    expect(lastSessionsTableCallArgs()?.userId).toBeUndefined();
  });

  it("reads a scoped-away v2 list as filtered rather than genuinely empty", () => {
    // The false-completeness half, at the page. A scope the surface does not
    // hear leaves zero rows looking like an org with no sessions, and offers the
    // reader the onboarding copy instead of the control that undoes the scope.
    mockSessionsPageEmptyState("organization");
    renderScopedV2Page();

    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    expect(screen.queryByText("No sessions yet")).toBeNull();
  });

  it("strips ?userId= when the scope chip is removed, keeping the facets", () => {
    setSessionsFacetQuery(STATUS_PARAM, [SessionStatusFacetValue.Active]);
    renderScopedV2Page();

    navigationReplaceMock.mockClear();
    fireEvent.click(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL));

    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      // The scope leaves…
      expect(url).not.toContain(`${SELECTED_USER_PARAM}=`);
      // …and nothing else does. A strip that took the facets with it would be
      // the removal quietly doing a "Clear all" the reader never asked for.
      expect(url).toContain(
        `${STATUS_PARAM}=${SessionStatusFacetValue.Active}`
      );
    }
  });

  it("strips ?userId= in every write Clear all makes, alongside the facets", () => {
    // THE case this ticket was deferred over. "Clear all" is one click and
    // several synchronous writes; the refuted wirings settle on a state with the
    // facets cleared and the scope PUT BACK, because the later write copies the
    // pre-click snapshot that still carries `?userId=`. Reading only the last
    // call would pass on a wiring where an earlier write had already restored
    // it, so every write is read.
    setSessionsFacetQuery(STATUS_PARAM, [SessionStatusFacetValue.Active]);
    renderScopedV2Page();

    navigationReplaceMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: CLEAR_ALL_LABEL }));

    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain(`${SELECTED_USER_PARAM}=`);
      expect(url).not.toContain(`${STATUS_PARAM}=`);
    }
  });

  it("strips ?userId= and the Owner facet in one write when the two are merged", () => {
    // The merged case the single chip claims to cover: the same person is both
    // the deep-link scope and a selected Owner value. They are two different URL
    // params, so a removal that dropped one and left the other would leave the
    // list narrowed under a chip that no longer names it.
    setSessionsFacetQuery(OWNER_FACET_PARAM, [SCOPED_USER_ID]);
    renderScopedV2Page();

    navigationReplaceMock.mockClear();
    fireEvent.click(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL));

    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain(`${SELECTED_USER_PARAM}=`);
      expect(url).not.toContain(`${OWNER_FACET_PARAM}=`);
    }
  });
});

/**
 * ISS-8037 (codex review) — one URL, ONE answer about whether it is scoped.
 *
 * `URLSearchParams.get` returns `""`, not `null`, for a URL ending in
 * `?userId=`. The page asked two questions of that value with two different
 * tests — `resolveSessionsScopeState`'s `Boolean(selectedUserId)` and the v2
 * axis's `!== null` — so the same URL read as unscoped to the empty state and as
 * SCOPED to the surface, which chipped a nameless Owner and offered to clear a
 * narrower that had never been applied. `readSessionsScopeUserId` normalises at
 * the read, which is what makes the two agree by construction rather than by two
 * checks that happen to match.
 */
describe("Sessions page — v2 owner scope from a valueless ?userId=", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
    localStorage.clear();
  });

  afterEach(() => {
    restoreContainerWidth?.();
    restoreContainerWidth = null;
  });

  it("treats ?userId= with no value as unscoped on both paths", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    setSelectedSessionUser("");
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    // The SURFACE's answer: no chip naming a scope, and no chip row at all — its
    // "Clear all" only mounts once `filtersActive` counts something, and pre-fix
    // the `!== null` test counted `""`.
    expect(screen.queryByLabelText(ANY_SCOPE_CHIP_REMOVE)).toBeNull();
    expect(screen.queryByRole("button", { name: CLEAR_ALL_LABEL })).toBeNull();
    // The READ's answer, and the one that proves the two now agree: pre-fix the
    // list query carried `userId: ""` — a scope on the empty string, sent to the
    // server, while `resolveSessionsScopeState` called the same URL unscoped.
    expect(lastSessionsTableCallArgs()?.userId).toBeUndefined();
  });

  it("still scopes a ?userId= that names someone", () => {
    // The positive sibling, on the same normaliser: a check that turned every
    // value into `null` would pass the case above and silently retire the scope.
    renderScopedV2Page();

    expect(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL)).toBeInTheDocument();
    expect(lastSessionsTableCallArgs()?.userId).toBe(SCOPED_USER_ID);
  });
});

/**
 * ISS-8037 (codex review) — the owner-scope write must not take the Project
 * facet with it.
 *
 * `applyProjectFacetGate` empties `projectIds` when the Project facet flag is
 * off, and that GATED object is what the v2 surface is handed and reports back.
 * Routing it into `writeSessionFacetFilterParams` deletes an inbound `?project=`
 * the gate had merely made inert, so removing the Owner chip silently dropped a
 * narrower the reader never touched and could not see to restore.
 */
describe("Sessions page — v2 owner-scope write and the gated Project facet", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
    localStorage.clear();
  });

  afterEach(() => {
    restoreContainerWidth?.();
    restoreContainerWidth = null;
  });

  it("keeps an inert ?project= when the Project facet is gated off", () => {
    // The flag is deliberately NOT enabled: `?project=` is present, gated to
    // inert, and invisible on the surface — the exact state where the surface
    // cannot have asked for its removal.
    setSessionsFacetQuery(PROJECT_FACET_PARAM, [SCOPED_PROJECT_ID]);
    renderScopedV2Page();

    navigationReplaceMock.mockClear();
    fireEvent.click(screen.getByLabelText(SCOPE_CHIP_REMOVE_LABEL));

    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain(`${SELECTED_USER_PARAM}=`);
      expect(url).toContain(`${PROJECT_FACET_PARAM}=${SCOPED_PROJECT_ID}`);
    }
  });

  it("still removes ?project= when the reader clears it with the facet on", () => {
    // The other direction, and the one that stops the fix from becoming "never
    // clear the Project facet": flag ON, the gate is identity, and a real clear
    // has to reach the URL.
    setSessionsFacetQuery(PROJECT_FACET_PARAM, [SCOPED_PROJECT_ID]);
    enableSessionsPageFeatureFlag(SESSIONS_PROJECT_FACET_FEATURE_FLAG_KEY);
    renderScopedV2Page();

    navigationReplaceMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: CLEAR_ALL_LABEL }));

    const urls = writtenUrls();
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain(`${PROJECT_FACET_PARAM}=`);
      expect(url).not.toContain(`${SELECTED_USER_PARAM}=`);
    }
  });
});
