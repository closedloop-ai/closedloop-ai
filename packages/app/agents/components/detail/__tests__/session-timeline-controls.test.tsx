import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  TIMELINE_SCALE_OPTIONS,
  TIMELINE_VISIBLE_COLUMNS,
} from "@repo/app/agents/lib/session-timeline-scale";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSessionDetailFixture,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { SessionTimelineBars } from "../session-timeline-bars";
import { TIMELINE_INTERPOLATED_SCALE_NOTE } from "../session-timeline-controls";
import {
  resetTraceComments,
  withProviders,
} from "./agent-session-detail-view.test-helpers";

/**
 * ISS-5819 — the Session Timeline's scale toggle, "Group by" select and time
 * scrubber, and the 24-column clock window they act on.
 *
 * Every assertion here is on BEHAVIOUR: the toggle changes which stretch of time
 * the columns cover, the scrubber moves the position marker, the scrubber is
 * absent exactly when the session fits. A test that only asserted the controls
 * were present would stay green against controls wired to nothing — which is the
 * failure mode the ticket calls out by name.
 *
 * ISS-5999 graduated these controls to unconditional and deleted the
 * `sessions-detail-prototype-parity` key, so each block's flag-OFF twin is gone
 * rather than skipped. Each retargeted assertion still fails against pre-ISS-5819
 * production, because it pins the 24-column window and the controls acting on it
 * — neither of which the duration-derived strip had.
 *
 * The four GROUPINGS' arithmetic is pinned in
 * `agents/lib/__tests__/session-timeline-projection.test.ts`, where the stacker
 * is a pure function and each cut can be compared against the others. What is
 * pinned HERE is the other half of that chain — that a stack actually reaches the
 * DOM and repaints when it changes.
 */

const SCALE_GROUP_NAME = "Timeline scale";
/**
 * Every scale radio's accessible name, derived from the SAME option list the
 * control renders from (`session-timeline-controls.tsx:81`) rather than
 * re-typed, so a new scale is swept automatically instead of silently skipped.
 */
const SCALE_RADIO_NAMES = TIMELINE_SCALE_OPTIONS.map(
  (option) => `${option} timeline scale`
);
/*
 * The control's accessible name is now its VISIBLE label (WCAG 2.5.3), so the
 * tests query by that. The fuller "Group stacked bars by" survives as the
 * trigger's `title`, not as its name.
 */
const GROUP_BY_NAME = /group by/i;
const SCRUBBER_NAME = "Session time position";
/*
 * #4753: the scale options are queried by their FULL accessible name below, and
 * that is safe HERE but not everywhere. Testing Library treats a string `name`
 * as a whole-string match, so `"5m timeline scale"` cannot also select the `15m`
 * radio. Playwright's `getByRole` matches the accessible name by SUBSTRING, so
 * the identical query there resolved to two radios and died on strict mode —
 * which is exactly how it reached CI green here and red in the e2e twins.
 *
 * If a locator is ever moved between this file and
 * `session-detail-prototype-parity.spec.ts`, the Playwright side needs
 * `exact: true`; those specs carry the same note.
 */
const BAR_SELECTOR = ".sd3-bar2";
const AXIS_SELECTOR = ".sd3-act-axis";
/** The axis's middle cell — the calendar-span caption, the only one with a title. */
const AXIS_SPAN_SELECTOR = ".sd3-act-axis span[title]";
const FIXED_NOW = new Date("2026-06-10T12:00:00.000Z");
const SESSION_START = new Date("2026-06-10T00:00:00.000Z");
const HOUR_MS = 3_600_000;
/*
 * 20 days. `defaultTimelineScale` picks the COARSEST scale whose 24 columns
 * still cover the run, so at its opening scale a session almost always fits and
 * correctly shows no scrubber — the only runs that overflow even `12h` are those
 * past 24 x 12h = 12 days. A shorter fixture would make the scrubber absent for
 * the right reason and read as the control being broken.
 */
const LONG_SESSION_MS = 20 * 24 * HOUR_MS;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  resetTraceComments();
});

describe("the timeline renders a stable 24-column window, not a duration-derived strip", () => {
  it("draws 24 columns for a 40-bin strip when gated on", () => {
    renderDetail(longSession(40));
    expect(document.querySelectorAll(BAR_SELECTOR)).toHaveLength(
      TIMELINE_VISIBLE_COLUMNS
    );
  });

  it("draws 24 columns for a 12-bin strip too — the count stops tracking duration", () => {
    renderDetail(longSession(12));
    expect(document.querySelectorAll(BAR_SELECTOR)).toHaveLength(
      TIMELINE_VISIBLE_COLUMNS
    );
  });
});

describe("the scale toggle changes the rendered window", () => {
  it("offers the prototype's four scales under the prototype's label", () => {
    renderDetail(longSession(40));
    const group = screen.getByRole("group", { name: SCALE_GROUP_NAME });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((option) => option.textContent)
    ).toEqual(["5m", "15m", "1h", "12h"]);
  });

  it("shows a different stretch of time after the scale changes", () => {
    renderDetail(longSession(40));
    const before = axisText();

    fireEvent.click(screen.getByRole("radio", { name: "5m timeline scale" }));

    /*
     * The load-bearing assertion of this file. A toggle that merely re-rendered
     * — or that set state nothing consumed — would leave the axis naming the
     * same two instants. The axis ticks are formatted from the very window the
     * bars are plotted over, so a change here is a change in what is on screen.
     */
    expect(axisText()).not.toBe(before);
    // And the column count does NOT move with it: that is the window's job.
    expect(document.querySelectorAll(BAR_SELECTOR)).toHaveLength(
      TIMELINE_VISIBLE_COLUMNS
    );
  });

  it("is keyboard operable — the toggle activates from the keyboard alone", async () => {
    /*
     * No `fireEvent.click` anywhere in this test, deliberately. The version this
     * replaced fired keydown/keyup AND a click, and jsdom does not synthesise a
     * click from a keydown — so the click alone satisfied the assertion and the
     * keyboard path was never exercised. `userEvent` dispatches the full
     * sequence a real key press produces, including the activation click the
     * browser derives from it.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDetail(longSession(40));
    const before = axisText();
    // A 20-day run opens on `12h`, so that is the item holding the roving
    // tabindex. Focus is placed there and everything after it is key input.
    screen.getByRole("radio", { name: "12h timeline scale" }).focus();

    await user.keyboard("{ArrowLeft}");
    await user.keyboard("{Enter}");

    expect(axisText()).not.toBe(before);
  });
});

describe("the strip says so when a scale is finer than what was measured", () => {
  /*
   * ISS-5819 review (wongk). `projectSessionTimeline` already knew a column
   * could be narrower than the bin it was cut from — it reports
   * `subColumnSource` — but nothing downstream said it, so a `5m` view of a
   * 12-hour-binned strip read as five-minute measurement.
   *
   * A 20-day run in 40 bins is a 12-hour bin: `12h` columns are cut at the bin's
   * own width and nothing is interpolated; `5m` columns are cut from inside one.
   * Both arms are asserted with the SAME query, so the absent case cannot pass
   * by matching nothing anywhere.
   */
  it("says nothing at a scale no finer than the recorded bins", () => {
    renderDetail(longSession(40));

    // A 20-day run opens on `12h`, the bin's own width.
    expect(
      screen.getByRole("radio", { name: "12h timeline scale" })
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.queryByText(TIMELINE_INTERPOLATED_SCALE_NOTE)
    ).not.toBeInTheDocument();
  });

  it("tells the reader the bars are interpolated at a finer scale", () => {
    renderDetail(longSession(40));

    fireEvent.click(screen.getByRole("radio", { name: "5m timeline scale" }));

    expect(
      screen.getByText(TIMELINE_INTERPOLATED_SCALE_NOTE)
    ).toBeInTheDocument();
    // And it is attached to the control that caused it, so it is not sight-only.
    const note = screen.getByText(TIMELINE_INTERPOLATED_SCALE_NOTE);
    expect(
      screen.getByRole("group", { name: SCALE_GROUP_NAME })
    ).toHaveAttribute("aria-describedby", note.id);
  });
});

describe("the Group by select offers the prototype's four cuts", () => {
  it("names itself as the prototype does and starts on Token Type", () => {
    renderDetail(longSession(40));
    const trigger = screen.getByRole("combobox", { name: GROUP_BY_NAME });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("Token Type");
  });

  it("takes its accessible name FROM the visible label", () => {
    /*
     * WCAG 2.5.3 Label in Name. The old assertion here only checked that the
     * words "Group by" appeared somewhere on the page, which stayed green while
     * the control's name was the unrelated "Group stacked bars by" — so a
     * speech-input user saying "click Group by" could not reach it. Querying the
     * combobox BY that name is what fails against the unassociated version.
     */
    renderDetail(longSession(40));
    expect(
      screen.getByRole("combobox", { name: GROUP_BY_NAME })
    ).toBeInTheDocument();
  });

  it("repaints a bar's stack when the grouping's segments change", () => {
    /*
     * The DOM half of the grouping chain (the arithmetic half is in
     * `session-timeline-projection.test.ts`). Driving the Radix listbox in jsdom
     * would test Radix; driving the bar row with the two stacks a grouping
     * change actually produces tests OUR wiring — that a stack reaches the
     * painted segments at all, and that a different stack paints differently.
     */
    const bucket = pricedBucket();
    const tokenTypeStack = [
      [
        {
          colorVar: "var(--chart-3)",
          key: "cache",
          label: "Cache",
          value: 0.5,
        },
        {
          colorVar: "var(--chart-2)",
          key: "output",
          label: "Output",
          value: 0.5,
        },
        { colorVar: "var(--chart-1)", key: "input", label: "Input", value: 1 },
      ],
    ];
    const modelStack = [
      [
        {
          colorVar: "var(--chart-1)",
          key: "claude-opus-5",
          label: "claude-opus-5",
          value: 2,
        },
      ],
    ];

    const first = render(barsWithStacks(bucket, tokenTypeStack));
    expect(first.container.querySelectorAll(`${BAR_SELECTOR} i`)).toHaveLength(
      3
    );
    first.unmount();

    const second = render(barsWithStacks(bucket, modelStack));
    expect(second.container.querySelectorAll(`${BAR_SELECTOR} i`)).toHaveLength(
      1
    );
  });

  it("keeps the in/out/cache stack when no grouping is supplied", () => {
    // `stacks={null}` is what every ungated caller passes; the three hardcoded
    // segments must survive it untouched.
    const { container } = render(barsWithStacks(pricedBucket(), null));
    expect(container.querySelectorAll(`${BAR_SELECTOR} i.cb-in`)).toHaveLength(
      1
    );
    expect(container.querySelectorAll(`${BAR_SELECTOR} i.cb-out`)).toHaveLength(
      1
    );
    expect(
      container.querySelectorAll(`${BAR_SELECTOR} i.cb-cache`)
    ).toHaveLength(1);
  });
});

describe("the scrubber appears exactly when the session exceeds the window", () => {
  it("renders for a session longer than its window, under the prototype's label", () => {
    renderDetail(longSession(40));
    expect(screen.getByRole("slider", { name: SCRUBBER_NAME })).toBeVisible();
  });

  it("does not render for a session that fits the window", () => {
    /*
     * The confidence caveat the ticket flags, settled in a test rather than by
     * argument: the scrubber is CONDITIONAL, so its absence on a short session
     * is correct and proves nothing about production. This pins both directions
     * so neither can be mistaken for the other again.
     */
    renderDetail(shortSession());
    expect(screen.queryByRole("slider", { name: SCRUBBER_NAME })).toBeNull();
  });

  it("moves the position marker — the thumb and the marker are one control", () => {
    /*
     * ISS-5843 depends on this being ONE model: dragging the thumb and clicking
     * a bucket must move the same indicator. Asserting the marker moves when the
     * thumb moves is what proves they are not two positions that will drift.
     */
    renderDetail(longSession(40));
    const scrubber = screen.getByRole("slider", { name: SCRUBBER_NAME });
    // Captured BEFORE. Asserting only that `left` is non-empty is always true —
    // `.tl-here` renders only when the percentage resolves — so a marker frozen
    // at one position would have passed.
    const before = markerLeft();

    fireEvent.change(scrubber, { target: { value: "30" } });

    expect(markerLeft()).not.toBe(before);
    expect(markerLeft()).not.toBeNull();
    expect(scrubber).toHaveValue("30");
  });

  it("is keyboard operable and announces where in the session it sits", () => {
    renderDetail(longSession(40));
    const scrubber = screen.getByRole("slider", { name: SCRUBBER_NAME });
    scrubber.focus();
    expect(document.activeElement).toBe(scrubber);
    // A native range input carries arrow/Home/End for free; what it does NOT
    // carry for free is a value a screen reader can place, hence the text.
    expect(scrubber).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("of")
    );
  });
});

describe("the axis caption measures the run, not the window", () => {
  /*
   * #4753. The windowed axis used to hand the caption
   * `formatDuration(windowStart, windowEnd)`, so a 20-minute run opened at `5m`
   * — whose 24 columns are two hours wide — reported "calendar span 2h 0m".
   *
   * Two things make that a lie rather than a choice. The caption's own tooltip
   * promises calendar time between the first and last EVENT, and a window is a
   * VIEWPORT: it is picked by `defaultTimelineScale` and moved by the scrubber,
   * so a duration read off it changes when the reader changes the zoom, which no
   * real duration does. ISS-4791 also requires this caption to reconcile with
   * the "phases span" caption directly beneath it, which reports the run.
   *
   * The TICKS still follow the window — the bars are drawn over it — which is
   * why the sibling tests above still see the axis text change on a scale
   * change. This asserts the one part of it that must not move.
   */
  it("keeps the session's own span in the caption at EVERY scale", () => {
    /*
     * ISS-5999: this absorbed the flag-off twin that used to prove the point by
     * comparing against an unwindowed render. Sweeping all four scales is the
     * stronger form of the same counterfactual — each scale spans a different
     * amount of clock (2h at `5m`, 12 days at `12h` for this 20-day fixture), so
     * a caption pointed at the WINDOW reports four different values while the
     * run's own span reports one.
     */
    renderDetail(longSession(40));
    const beforeSpan = axisSpanText();
    let previousAxis = axisText();
    expect(beforeSpan).not.toBe("");

    for (const scale of SCALE_RADIO_NAMES) {
      fireEvent.click(screen.getByRole("radio", { name: scale }));
      // The ticks moved (that is the window doing its job) ...
      expect(axisText(), `${scale} must move the ticks`).not.toBe(previousAxis);
      previousAxis = axisText();
      // ... and the run's measured span did not.
      expect(axisSpanText(), `${scale} must not move the span`).toBe(
        beforeSpan
      );
    }
  });
});

describe("opening a different session starts at that session's own beginning", () => {
  /*
   * #4753 review (wongk). `activeRow` used to live ABOVE the `key={session.id}`
   * that remounts the detail workspace, so it was the one piece of per-session
   * state that survived same-component navigation. Before this ticket that was
   * nearly invisible — the row only positioned the `.tl-here` marker, and the
   * first scroll corrected it. It stopped being invisible once the row also
   * picked the timeline's COLUMN and the window FOLLOWED that column: the next
   * session opened panned to wherever the reader had been in the PREVIOUS one,
   * showing an empty stretch of clock instead of the run.
   */
  it("does not carry the previous session's position into the next one", () => {
    const first = longSession(40);
    const second = {
      ...longSession(40),
      id: "session-detail-2",
      name: "Second windowed session",
    };
    const { rerender } = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={first}
        />
      )
    );

    // Move the reader deep into the FIRST session by jumping from a late column,
    // which is what sets `activeRow` in production.
    const bars = Array.from(
      document.querySelectorAll<HTMLElement>(BAR_SELECTOR)
    );
    const lastBar = bars.at(-1);
    if (!lastBar) {
      throw new Error("fixture rendered no timeline bars to jump from");
    }
    fireEvent.click(lastBar);
    const movedTo = Number(
      screen.getByRole("slider", { name: SCRUBBER_NAME }).getAttribute("value")
    );
    // The fixture has to actually move, or the assertion below proves nothing.
    expect(movedTo).toBeGreaterThan(0);

    rerender(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={second}
        />
      )
    );

    expect(screen.getByRole("slider", { name: SCRUBBER_NAME })).toHaveValue(
      "0"
    );
  });
});

describe("the timeline is identical under both adapters' prop sets", () => {
  it("ignores the props that differ between web and desktop, on one screen", () => {
    /*
     * Scoped honestly: this renders the SHARED `AgentSessionDetailView` twice,
     * with the two adapters' real prop sets, and compares the results against
     * each other. It cannot catch a divergence inside
     * `apps/desktop/src/renderer/components/sessions/SessionDetailView.tsx`,
     * which is not imported here — what it proves is that the props that DO
     * differ between the surfaces reach none of the timeline. Flag parity itself
     * is pinned separately by `apps/desktop/test/feature-flags-cross-surface`.
     *
     * Compared against EACH OTHER rather than each against a constant:
     * comparing independently to a literal passes happily while both drift
     * together, and passes if one side stops rendering a control.
     *
     * The prop sets are the real ones. Web
     * (`apps/app/.../sessions/[id]/page.tsx`) passes `commentsRailOpen` and a
     * `getBranchHref`; desktop
     * (`apps/desktop/src/renderer/components/sessions/SessionDetailView.tsx`)
     * passes neither. Those are the divergences that already exist on this page;
     * this asserts they do not reach the timeline ISS-5819 changed.
     */
    const session = longSession(40);

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
    const webShape = readTimelineShape(web.container);
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
    const desktopShape = readTimelineShape(desktop.container);

    expect(desktopShape).toEqual(webShape);
    // Not a vacuous pass: both surfaces must actually carry the new controls and
    // the windowed column count, or two empty shapes would compare equal.
    expect(webShape.scaleOptions).toEqual(["5m", "15m", "1h", "12h"]);
    expect(webShape.groupBy).toBe("Token Type");
    expect(webShape.barCount).toBe(TIMELINE_VISIBLE_COLUMNS);
    expect(webShape.hasScrubber).toBe(true);
    expect(webShape.axis).not.toBe("");
  });
});

function renderDetail(
  session: ReturnType<typeof createAgentSessionDetailFixture>
) {
  return render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    )
  );
}

function barsWithStacks(
  bucket: ActivityBucket,
  stacks:
    | { colorVar: string; key: string; label: string; value: number }[][]
    | null
) {
  return (
    <SessionTimelineBars
      accessibleCosts={[null]}
      buckets={[bucket]}
      columnHitTargetEnabled={false}
      costUnmeasured={false}
      disabled={false}
      hoverIndex={null}
      jumpBlocks={[null]}
      maxCost={2}
      onHover={() => undefined}
      onJump={() => undefined}
      stacks={stacks}
      unreadFromIndex={1}
    />
  );
}

function readTimelineShape(container: HTMLElement) {
  const scaleGroup = container.querySelector('[aria-label="Timeline scale"]');
  return {
    axis: container.querySelector(AXIS_SELECTOR)?.textContent ?? "",
    barCount: container.querySelectorAll(BAR_SELECTOR).length,
    groupBy: container.querySelector('[role="combobox"]')?.textContent ?? "",
    hasScrubber:
      container.querySelector(`[aria-label="${SCRUBBER_NAME}"]`) !== null,
    scaleOptions: [...(scaleGroup?.querySelectorAll("button") ?? [])].map(
      (option) => option.textContent
    ),
  };
}

function markerLeft(): string | null {
  const marker = document.querySelector(".tl-here");
  return marker instanceof HTMLElement ? marker.style.left : null;
}

function axisText(): string {
  return document.querySelector(AXIS_SELECTOR)?.textContent ?? "";
}

function axisSpanText(): string {
  return document.querySelector(AXIS_SPAN_SELECTOR)?.textContent ?? "";
}

function pricedBucket(): ActivityBucket {
  return {
    byModel: { "claude-opus-5": { cCache: 0.5, cIn: 1, cOut: 0.5 } },
    cCache: 0.5,
    cIn: 1,
    cOut: 0.5,
    key: "priced-0",
    label: "9:00",
    tl0: 0,
    toolStart: 1,
    total: 2,
  };
}

/**
 * A 20-day run whose strip carries `binCount` uniform bins — the shape the
 * desktop producer syncs. Long enough that 24 columns cannot cover it at ANY
 * scale, which is what puts the scrubber on screen at the opening scale.
 */
function longSession(binCount: number) {
  return createAgentSessionDetailFixture({
    // ISS-5819 review (wongk): the bins state the clock they were binned over,
    // as a real producer's do — the projection these cases exercise refuses a
    // strip that cannot.
    activityBuckets: withProducerBinBounds(uniformBins(binCount), {
      endMs: SESSION_START.getTime() + LONG_SESSION_MS,
      startMs: SESSION_START.getTime(),
    }),
    /*
     * The window the strip is plotted over comes from PLOTTED activity
     * (`resolveSessionTimelineWindow`), and `ActivityBucket` carries no
     * timestamps — the classifier tiling is what gives the window its real
     * extent. Supplying it is what makes this a 12-hour session rather than a
     * three-minute one, and it gives the phase grouping something to cut by.
     */
    activitySegmentRows: [
      {
        confidence: 1,
        endMs: SESSION_START.getTime() + LONG_SESSION_MS / 3,
        evidenceLayers: ["declared"],
        phase: "explore",
        startMs: SESSION_START.getTime(),
        version: 1,
      },
      {
        confidence: 1,
        endMs: SESSION_START.getTime() + LONG_SESSION_MS,
        evidenceLayers: ["declared"],
        phase: "implement",
        startMs: SESSION_START.getTime() + LONG_SESSION_MS / 3,
        version: 1,
      },
    ],
    endedAt: new Date(SESSION_START.getTime() + LONG_SESSION_MS),
    lastActivityAt: new Date(SESSION_START.getTime() + LONG_SESSION_MS),
    name: "Windowed timeline session",
    startedAt: SESSION_START,
    status: SESSION_STATUS.INACTIVE,
  });
}

/** A 40-minute run: 24 columns at the default `5m` scale cover it whole. */
function shortSession() {
  return createAgentSessionDetailFixture({
    activityBuckets: withProducerBinBounds(uniformBins(8), {
      endMs: SESSION_START.getTime() + 40 * 60_000,
      startMs: SESSION_START.getTime(),
    }),
    activitySegmentRows: [
      {
        confidence: 1,
        endMs: SESSION_START.getTime() + 40 * 60_000,
        evidenceLayers: ["declared"],
        phase: "implement",
        startMs: SESSION_START.getTime(),
        version: 1,
      },
    ],
    endedAt: new Date(SESSION_START.getTime() + 40 * 60_000),
    lastActivityAt: new Date(SESSION_START.getTime() + 40 * 60_000),
    name: "Short timeline session",
    startedAt: SESSION_START,
    status: SESSION_STATUS.INACTIVE,
  });
}

function uniformBins(count: number): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) => ({
    byModel: { "claude-opus-5": { cCache: 0.5, cIn: 1, cOut: 0.5 } },
    cCache: 0.5,
    cIn: 1,
    cOut: 0.5,
    key: `bin-${index}`,
    label: `bin ${index}`,
    tl0: index,
    toolStart: 1,
    total: 2,
  }));
}
