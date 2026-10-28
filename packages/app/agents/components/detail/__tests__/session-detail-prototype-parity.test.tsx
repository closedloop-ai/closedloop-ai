import {
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { SESSION_DURATION_TICK_MS } from "@repo/app/agents/lib/session-duration";
import { TRACE_ROW_SELECTOR } from "@repo/app/agents/lib/trace-scroll-target";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  resetTraceComments,
  seedSessionTraceComment,
  withProviders,
} from "./agent-session-detail-view.test-helpers";

/**
 * ISS-5818 — prototype-conformance regressions for the Sessions DETAIL page,
 * from the ISS-5593 VQA drift pass. The prototype
 * (`packages/app/agents/components/sessions/web-master-legacy-preview/components/session-detail.tsx`)
 * was the source of truth during promotion; every assertion below pins the
 * resulting production contract.
 *
 * These assert rendered STRUCTURE — which element the title's status chip is, in
 * which order the regions appear, which headings and landmarks the document
 * exposes — never class names. A class assertion would keep passing against a
 * `span` renamed to look like a heading, which is exactly the defect D5
 * describes.
 *
 * ISS-5999 graduated this work to unconditional and deleted the
 * `sessions-detail-prototype-parity` key, so the flag-OFF twin each `describe`
 * used to carry is gone rather than skipped. What kept those tests honest —
 * that they would fail against the pre-ISS-5818 component — is now carried by
 * the assertions themselves: each pins the ELEMENT and the ORDER the pre-parity
 * markup did not have (a `span` is not `role="heading"`, and Timeline-first is
 * not Properties-first), so a regression to that markup fails here.
 */

const ACTIVE_SESSION_NAME_RE = /Prototype parity session/;
const COMMENTS_HEADING_RE = /Comments/;

/*
 * `resolveDisplayedSessionStatus` folds a silent `active` run to "Stale" against
 * a 24h cutoff measured from its OWN `new Date()` — the production call site
 * injects no clock. So the title chip is clock-driven behavior, and the repo
 * rule for that is categorical: pin the time, never lean on the wall clock.
 */
const FIXED_NOW = new Date("2026-06-10T12:00:00.000Z");

beforeEach(() => {
  // `shouldAdvanceTime` so the clock is PINNED but not FROZEN: the comments rail
  // resolves its discovery read asynchronously, and a fully frozen clock leaves
  // Testing Library's `findBy*` waiting on a timer that never fires.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  resetTraceComments();
});

describe("ISS-5818 D1: the session status chip renders inside the title", () => {
  it("renders the status chip inline with the h1, on the same row", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={activeSessionFixture()}
        />
      )
    );

    const heading = screen.getByRole("heading", {
      level: 1,
      name: ACTIVE_SESSION_NAME_RE,
    });
    // The chip is a SIBLING on the title row, not a descendant of the h1: the
    // prototype puts both inside one flex row so the status never becomes part
    // of the heading's accessible name (WCAG 2.4.6 — the heading names the
    // session, not its state).
    const titleRow = heading.parentElement;
    expect(titleRow).not.toBeNull();
    expect(
      within(titleRow as HTMLElement).getByText(
        SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
      )
    ).toBeInTheDocument();
  });

  it("keeps badging a silent active run Active in the title, exactly as the list row does", () => {
    // ISS-4997/ISS-4998 guard: the title chip must read the DISPLAYED status
    // (`resolveDisplayedSessionStatus`), not raw `session.status`, so the title
    // and the list cannot disagree about one run. ISS-10364 (operator ruling,
    // 2026-09-23) retired the staleness fold that guard used to pin — the
    // resolver no longer reads `now` at all — so a run still stored `active`
    // but silent since 2020 now says "Active" here, for the same reason the
    // Sessions list does.
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={staleSessionFixture()}
        />
      )
    );

    const heading = screen.getByRole("heading", { level: 1 });
    const titleRow = heading.parentElement as HTMLElement;
    expect(
      within(titleRow).getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE])
    ).toBeInTheDocument();
    // "Stale" is a plain literal now — ISS-10364 retired the label this used to
    // read from `SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.STALE]`.
    expect(within(titleRow).queryByText("Stale")).toBeNull();
  });

  it("states status ONCE — the collapsed Properties strip stops repeating it", () => {
    /*
     * Design-review finding. The title chip reads the `SESSION_STATUS` lifecycle
     * axis; the Properties strip reads `AgentSessionState` via `getStatusDisplay`.
     * They are deliberately different axes (ISS-5695 owns reconciling them) and
     * may legitimately disagree, so with both on one screen the page could say
     * "Stale" and "Running" 24px apart. Aliasing the axes is forbidden, so the
     * REDUNDANT statement is what goes.
     */
    const { container } = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={activeSessionFixture()}
        />
      )
    );

    const preview = container.querySelector(".sd3-props-preview");
    expect(preview).not.toBeNull();
    expect(
      (preview as HTMLElement).querySelector(".sd3-status-dot")
    ).toBeNull();
    // The chip in the title is the one remaining statement.
    expect(readTitleStatusText(container)).toBe(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );
  });
});

describe("ISS-5818 D2: Properties sits above the Timeline", () => {
  it("orders the regions Title -> Properties -> Timeline -> Trace", () => {
    const { container } = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={activeSessionFixture()}
        />
      )
    );

    expect(readRegionOrder(container)).toEqual([
      "title",
      "properties",
      "timeline",
      "trace",
    ]);
  });

  it("pins the Timeline alone, with the title and Properties outside the sticky box", () => {
    // The sticky decision this ticket had to make, pinned as a contract rather
    // than left to a reviewer's eye. The prototype pins the timeline block only
    // (`session-detail.tsx:87-99`), and FEA-4025's rule — the pinned block must
    // stay small enough that it can never occlude the trace — is served harder
    // by a box holding one strip than by one holding an expandable 21-row
    // disclosure as well.
    const { container } = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={activeSessionFixture()}
        />
      )
    );

    const sticky = container.querySelector(".sd3-stickyhead.is-sticky");
    expect(sticky).not.toBeNull();
    const stickyBox = sticky as HTMLElement;
    expect(stickyBox.querySelector("h1")).toBeNull();
    expect(stickyBox.querySelector(".sd3-props")).toBeNull();
    expect(within(stickyBox).getByText("Session Timeline")).toBeInTheDocument();
  });
});

describe("ISS-5818 D5: section headings are real headings inside landmarks", () => {
  it("exposes Timeline and Trace as h2s named by their own landmarks", () => {
    const { container } = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={activeSessionFixture()}
        />
      )
    );

    for (const name of ["Session Timeline", "Session Trace"]) {
      const heading = screen.getByRole("heading", { level: 2, name });
      const section = heading.closest("section[aria-labelledby]");
      expect(
        section,
        `${name} must sit inside a labelled section`
      ).not.toBeNull();
      // The landmark must actually POINT at this heading. A mismatched id is
      // worse than no landmark: the region still appears in a screen reader's
      // landmark list, unnamed.
      expect((section as HTMLElement).getAttribute("aria-labelledby")).toBe(
        heading.id
      );
      expect(heading.id).not.toBe("");
    }

    expect(container.querySelectorAll("section[aria-labelledby]").length).toBe(
      2
    );
  });

  it("labels the EMPTY timeline the same way, with no activity to plot", () => {
    /*
     * A separate early return in `SessionActivityTimeline` (`buckets.length === 0`),
     * and the common case for a session that has not recorded anything yet — so
     * it is exactly the state a screen reader most needs named. Covering only the
     * populated strip would let a regression that dropped `labelled` on this
     * branch ship silently.
     */
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={emptyTimelineSessionFixture()}
        />
      )
    );

    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Session Timeline",
    });
    expect(heading.closest("section[aria-labelledby]")).not.toBeNull();
    expect(
      screen.getByText("No activity recorded for this session.")
    ).toBeInTheDocument();
  });

  it("keeps the timeline heading text untouched — the string is ISS-5129, not this ticket", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={activeSessionFixture()}
        />
      )
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Session Timeline" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Session Costs Over Time")).toBeNull();
  });
});

describe("ISS-5818 D5: the Comments rail heading", () => {
  /*
   * The page's THIRD span-as-heading, and the one a naive render never reaches:
   * FEA-4233 collapses the rail to a slim handle until a discovery read confirms
   * the session actually has comments, so these seed one first. Without this the
   * D5 landmark work would ship two-thirds done and no test would notice.
   */
  it("exposes Comments as an h2 inside the rail's own aside landmark", async () => {
    const session = activeSessionFixture();
    seedSessionTraceComment(session.id);

    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen
          isLoading={false}
          session={session}
        />
      )
    );

    const heading = await screen.findByRole("heading", {
      level: 2,
      name: COMMENTS_HEADING_RE,
    });
    // No `section[aria-labelledby]` here on purpose: the rail is already an
    // `<aside>`, which IS a landmark, and wrapping it in a region would nest two
    // landmarks around one panel.
    expect(heading.closest("aside")).not.toBeNull();
  });
});

describe("ISS-5818 (#4739 review): the title chip's display derivation", () => {
  /**
   * ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24) retired the
   * Waiting projection this case used to pin: the title chip no longer reads
   * `awaitingInputSince` at all, so a stored `active` row with the anchor set
   * now badges plain Active — exactly like one with no anchor at all. Kept as
   * the counterfactual for the withdrawn projection.
   */
  it("ISS-10364: badges an awaiting-input run plain Active, since the Waiting word is retired", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={awaitingInputSessionFixture()}
        />
      )
    );

    const titleRow = screen.getByRole("heading", { level: 1 })
      .parentElement as HTMLElement;
    expect(
      within(titleRow).getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE])
    ).toBeInTheDocument();
  });

  it("keeps claiming Active once an open page crosses the old staleness cutoff (ISS-10364)", () => {
    /*
     * A detail page is a surface that stays open for hours. ISS-10364 (operator
     * ruling, 2026-09-23) made `resolveDisplayedSessionStatus` stop reading
     * `now` altogether, so the chip's word no longer depends on the clock and
     * the coarse clock that used to advance it was deleted with the fold. This
     * pins that the retired fold does not silently come back.
     */
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={nearlyStaleSessionFixture()}
        />
      )
    );

    const titleRow = screen.getByRole("heading", { level: 1 })
      .parentElement as HTMLElement;
    expect(
      within(titleRow).getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE])
    ).toBeInTheDocument();

    act(() => {
      vi.setSystemTime(
        new Date(FIXED_NOW.getTime() + STALE_CROSSING_ADVANCE_MS)
      );
      vi.advanceTimersByTime(SESSION_DURATION_TICK_MS);
    });

    expect(
      within(titleRow).getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE])
    ).toBeInTheDocument();
    // "Stale" is a plain literal now — ISS-10364 retired the label this used to
    // read from `SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.STALE]`.
    expect(within(titleRow).queryByText("Stale")).toBeNull();
  });
});

describe("ISS-5818 (#4739 review): the Trace landmark's contents", () => {
  it("keeps the transcript inside the labelled Session Trace region", () => {
    /*
     * A `section[aria-labelledby]` that closes after its own heading is a named
     * region containing only its name: landmark navigation announces "Session
     * Trace" and lands on nothing. The prototype keeps the rows inside the
     * section, and so must this.
     *
     * Asserted through `TRACE_ROW_SELECTOR` — the selector production's own
     * scroll and jump code queries — rather than a class this test picked, so
     * the assertion tracks the contract the page already depends on.
     */
    const { container } = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={activeSessionFixture()}
        />
      )
    );

    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Session Trace",
    });
    const region = heading.closest("section");
    expect(region).not.toBeNull();
    // Not vacuous on either side: the page renders trace rows at all...
    expect(
      container.querySelectorAll(TRACE_ROW_SELECTOR).length
    ).toBeGreaterThan(0);
    // ...and every one of them is inside the region that claims to group them.
    expect(
      (region as HTMLElement).querySelectorAll(TRACE_ROW_SELECTOR)
    ).toHaveLength(container.querySelectorAll(TRACE_ROW_SELECTOR).length);
  });
});

describe("ISS-5818: web and desktop render the same screen", () => {
  it("produces an identical document outline and region order on both adapters", () => {
    /*
     * Criterion 4, done the way the ticket demands: the two surfaces are
     * compared against EACH OTHER on one rendered screen, not each against a
     * constant. Comparing each independently to a literal passes happily while
     * both drift together, and passes even if one adapter silently stops
     * rendering a region.
     *
     * The prop sets are the real ones. Web (`apps/app/.../sessions/[id]/page.tsx`)
     * passes `commentsRailOpen`; desktop
     * (`apps/desktop/src/renderer/components/sessions/SessionDetailView.tsx`)
     * never passes it and gates `getBranchHref` on `branchLinkResolvable`. Those
     * are the §3 divergences that already exist on this page — this asserts they
     * do not reach the layout ISS-5818 changed.
     */
    const session = activeSessionFixture();

    const web = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          commentsRailOpen
          getBranchHref={(id) => `/branches/${id}`}
          isLoading={false}
          session={session}
        />
      )
    );
    const webOutline = readDocumentOutline(web.container);
    const webRegions = readRegionOrder(web.container);
    const webTitleStatus = readTitleStatusText(web.container);
    web.unmount();

    const desktop = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={session}
        />
      )
    );
    const desktopOutline = readDocumentOutline(desktop.container);
    const desktopRegions = readRegionOrder(desktop.container);
    const desktopTitleStatus = readTitleStatusText(desktop.container);

    expect(desktopOutline).toEqual(webOutline);
    expect(desktopRegions).toEqual(webRegions);
    // D1 rides in the title ROW, not the outline — the chip is a sibling of the
    // `h1`, so a heading list cannot see it and the two comparisons above would
    // pass with the chip missing from one surface, or from both. Assert it on
    // each render explicitly (review finding, test-strategist).
    expect(webTitleStatus).toBe(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]);
    expect(desktopTitleStatus).toBe(webTitleStatus);
    // Not a vacuous pass: both surfaces must actually carry the new outline.
    expect(webOutline).toContainEqual({
      level: 2,
      text: "Session Timeline",
    });
    expect(webOutline).toContainEqual({ level: 2, text: "Session Trace" });
    expect(webRegions).toEqual(["title", "properties", "timeline", "trace"]);
  });
});

/**
 * The page's rendered document outline: every heading, in DOM order, as
 * `{ level, text }`. This is the artifact a screen-reader user navigates by, so
 * it is the right unit for the cross-surface comparison — it captures both the
 * ELEMENT (an `h2` vs a `span` simply is not in this list) and the order.
 */
function readDocumentOutline(
  container: HTMLElement
): { level: number; text: string }[] {
  return Array.from(container.querySelectorAll("h1, h2, h3")).map((node) => ({
    level: Number(node.tagName.slice(1)),
    text: (node.textContent ?? "").trim(),
  }));
}

/**
 * The four prototype-specified regions in DOM order, identified by a stable
 * structural anchor each rather than by a class the markup could rename around:
 * the `h1` for the title, the Properties disclosure's own label, the Timeline
 * strip's title, and the Trace head's title.
 *
 * Production-only regions (Activity phases, Activity breakdown, the transcript
 * file switcher) are deliberately NOT listed — they have no prototype
 * counterpart and reconciling them is ISS-5451's job, so this must not pin them.
 */
function readRegionOrder(container: HTMLElement): string[] {
  const regionBySelector = [
    ["h1", "title"],
    [".sd3-props", "properties"],
    [".sd3-actbar", "timeline"],
    [".sd3-tracehead", "trace"],
  ] as const;
  // One query over the union selector, so the nodes come back in DOCUMENT order
  // and the order is read rather than reconstructed by a comparator.
  const nodes = container.querySelectorAll(
    regionBySelector.map(([selector]) => selector).join(", ")
  );
  const order: string[] = [];
  for (const node of Array.from(nodes)) {
    const match = regionBySelector.find(([selector]) => node.matches(selector));
    // Each region is named once, at its FIRST appearance: the timeline strip's
    // container class also wraps its empty state, and a region repeating would
    // say nothing about order.
    if (match && !order.includes(match[1])) {
      order.push(match[1]);
    }
  }
  return order;
}

/**
 * The status word rendered on the title row beside the `h1`, or `null` when the
 * row carries no chip. Scoped to one container so the two surface renders can be
 * compared against EACH OTHER rather than against a screen-wide query.
 */
function readTitleStatusText(container: HTMLElement): string | null {
  const heading = container.querySelector("h1");
  const chip = heading?.parentElement?.querySelector('[data-slot="badge"]');
  return chip?.textContent?.trim() ?? null;
}

/** A live run, so the title chip has an Active state (and its pulse) to show. */
function activeSessionFixture() {
  return createAgentSessionDetailFixture({
    name: "Prototype parity session",
    status: SESSION_STATUS.ACTIVE,
    lastActivityAt: FIXED_NOW,
  });
}

/** A session with nothing to plot, so the timeline takes its empty-state return. */
function emptyTimelineSessionFixture() {
  return createAgentSessionDetailFixture({
    name: "Empty timeline session",
    status: SESSION_STATUS.ACTIVE,
    lastActivityAt: FIXED_NOW,
    activityBuckets: [],
    markers: [],
    turnItems: [],
    events: [],
  });
}

/**
 * A run still STORED `active` whose last activity is far past the (retired,
 * ISS-10364) display staleness cutoff — kept as the name it earned rather than
 * renamed, since the fixture's shape (silent since 2020) is still the useful
 * part; what it now proves is that going quiet no longer changes the badge.
 */
function staleSessionFixture() {
  return createAgentSessionDetailFixture({
    name: "Silent parity session",
    status: SESSION_STATUS.ACTIVE,
    startedAt: new Date("2020-01-01T00:00:00.000Z"),
    lastActivityAt: new Date("2020-01-01T00:00:00.000Z"),
  });
}

const HOUR_MS = 3_600_000;
/**
 * Far enough past `FIXED_NOW` that a session whose last activity sat one hour
 * inside the cutoff is now one hour outside it. Two hours, not twenty-five: the
 * point is that the CUTOFF moved under a fixed session, not that the session
 * aged.
 */
const STALE_CROSSING_ADVANCE_MS = 2 * HOUR_MS;

/**
 * A live run BLOCKED on the user, carrying the raw `active` status a desktop
 * local read serves when the independent displayed-status parity flag is off.
 */
function awaitingInputSessionFixture() {
  return createAgentSessionDetailFixture({
    awaitingInputSince: new Date(FIXED_NOW.getTime() - HOUR_MS),
    endedAt: null,
    lastActivityAt: new Date(FIXED_NOW.getTime() - HOUR_MS),
    name: "Awaiting input parity session",
    status: SESSION_STATUS.ACTIVE,
  });
}

/**
 * A live run one hour INSIDE the display staleness cutoff at `FIXED_NOW` — so it
 * badges Active on first paint and crosses the cutoff while the page stays open.
 */
function nearlyStaleSessionFixture() {
  const lastActivityAt = new Date(
    FIXED_NOW.getTime() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS - 1) * HOUR_MS
  );
  return createAgentSessionDetailFixture({
    endedAt: null,
    lastActivityAt,
    name: "Going quiet parity session",
    startedAt: lastActivityAt,
    status: SESSION_STATUS.ACTIVE,
  });
}
