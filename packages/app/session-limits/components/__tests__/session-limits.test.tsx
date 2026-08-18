import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  type SessionLimits,
  type SessionLimitsState,
  SessionLimitsStatus,
} from "../../types";
import { SessionLimitsBars } from "../session-limits-bars";
import { SessionLimitsDetail } from "../session-limits-detail";
import { SessionLimitsNav } from "../session-limits-nav";

// The provenance footer tucks the source into a Radix tooltip whose content
// portals out of jsdom; mock it so the tooltip content is inspectable inline.
vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const NOW = new Date("2026-07-19T12:00:00.000Z");
const SONNET_RE = /Sonnet/;
const CREDIT_SUMMARY_RE = /\$3\.50 of \$20\.00/;
const USED_PERCENT_RE = /% used/;
const AS_OF_RE = /As of/;
const ABSOLUTE_DATE_RE = /Jul 19/;
const RESET_RELATIVE_RE = /in 3h/;

function readyState(limits: SessionLimits): SessionLimitsState {
  return { status: SessionLimitsStatus.Ready, limits };
}

function makeLimits(overrides: Partial<SessionLimits> = {}): SessionLimits {
  return {
    fiveHour: { utilization: 42, resetsAt: "2026-07-19T15:00:00.000Z" },
    sevenDay: { utilization: 70, resetsAt: "2026-07-21T12:00:00.000Z" },
    sevenDayOpus: null,
    sevenDaySonnet: { utilization: 55, resetsAt: "2026-07-21T12:00:00.000Z" },
    extraUsage: {
      isEnabled: true,
      monthlyLimitUsd: 20,
      usedCreditsUsd: 3.5,
      utilization: 17.5,
    },
    fetchedAt: "2026-07-19T12:00:00.000Z",
    ...overrides,
  };
}

describe("SessionLimitsBars", () => {
  it("renders the session and week bars with floored usage", () => {
    render(<SessionLimitsBars limits={makeLimits()} now={NOW} />);
    expect(screen.getByText("Current session")).toBeInTheDocument();
    expect(screen.getByText("42% used")).toBeInTheDocument();
    expect(screen.getByText("Current week")).toBeInTheDocument();
    expect(screen.getByText("70% used")).toBeInTheDocument();
    // The per-model split is a detail-only concern, not shown in the nav.
    expect(screen.queryByText(SONNET_RE)).not.toBeInTheDocument();
  });

  it("omits a bar with no data", () => {
    render(
      <SessionLimitsBars limits={makeLimits({ fiveHour: null })} now={NOW} />
    );
    expect(screen.queryByText("Current session")).not.toBeInTheDocument();
    expect(screen.getByText("Current week")).toBeInTheDocument();
  });

  it("renders nothing when no window is present", () => {
    const { container } = render(
      <SessionLimitsBars
        limits={makeLimits({
          fiveHour: null,
          sevenDay: null,
          sevenDayOpus: null,
          sevenDaySonnet: null,
          extraUsage: null,
        })}
        now={NOW}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to a subset window so the summary is never empty", () => {
    // Opus/Sonnet-only week: no primary bar, but the nav still mounts — the
    // summary must render the available window (regression: empty trigger).
    render(
      <SessionLimitsBars
        limits={makeLimits({
          fiveHour: null,
          sevenDay: null,
          sevenDaySonnet: { utilization: 55, resetsAt: null },
        })}
        now={NOW}
      />
    );
    expect(screen.getByText("Current week, Sonnet")).toBeInTheDocument();
    expect(screen.getByText("55% used")).toBeInTheDocument();
  });

  it("falls back to extra-usage credits when it is the only window", () => {
    render(
      <SessionLimitsBars
        limits={makeLimits({
          fiveHour: null,
          sevenDay: null,
          sevenDaySonnet: null,
          extraUsage: {
            isEnabled: true,
            monthlyLimitUsd: 20,
            usedCreditsUsd: 3.5,
            utilization: 17.5,
          },
        })}
        now={NOW}
      />
    );
    expect(screen.getByText("Extra usage")).toBeInTheDocument();
    expect(screen.getByText("17% used")).toBeInTheDocument();
  });
});

describe("SessionLimitsDetail", () => {
  it("renders every available window plus extra-usage credits", () => {
    render(<SessionLimitsDetail limits={makeLimits()} now={NOW} />);
    expect(screen.getByText("Current session (5 hours)")).toBeInTheDocument();
    expect(screen.getByText("Current week, all models")).toBeInTheDocument();
    expect(screen.getByText("Current week, Sonnet")).toBeInTheDocument();
    expect(screen.getByText("Extra usage")).toBeInTheDocument();
    expect(screen.getByText(CREDIT_SUMMARY_RE)).toBeInTheDocument();
    // Opus window is null → not rendered.
    expect(screen.queryByText("Current week, Opus")).not.toBeInTheDocument();
  });

  it("shows a subscription hint when nothing is available", () => {
    render(
      <SessionLimitsDetail
        limits={makeLimits({
          fiveHour: null,
          sevenDay: null,
          sevenDaySonnet: null,
          extraUsage: null,
        })}
        now={NOW}
      />
    );
    expect(screen.getByTestId("limits-empty")).toBeInTheDocument();
  });

  it("shows freshness in the footer and tucks the source into a tooltip", () => {
    render(
      <SessionLimitsDetail
        limits={makeLimits({
          source: "statusline",
          fetchedAt: "2026-07-19T11:55:00.000Z",
        })}
        now={NOW}
      />
    );
    const provenance = screen.getByTestId("session-limits-provenance");
    // Freshness earns the footer text; the producer is secondary and lives in a
    // tooltip, so "Statusline" is not shown inline as producer jargon.
    expect(provenance).toHaveTextContent("Updated 5m ago");
    // The source is exposed via the tooltip content (revealed on hover/focus),
    // keeping the visible footer about "how current is this".
    expect(within(provenance).getByTestId("tooltip-content")).toHaveTextContent(
      "Source: Statusline"
    );
  });

  it("shows freshness without a tooltip when the source is unknown", () => {
    render(
      <SessionLimitsDetail
        limits={makeLimits({
          source: null,
          fetchedAt: "2026-07-19T11:55:00.000Z",
        })}
        now={NOW}
      />
    );
    const provenance = screen.getByTestId("session-limits-provenance");
    expect(provenance).toHaveTextContent("Updated 5m ago");
    // No source to reveal → plain text, no phantom (empty) tooltip affordance.
    expect(
      within(provenance).queryByTestId("tooltip-content")
    ).not.toBeInTheDocument();
  });

  it("omits the provenance footer when fetched-at is unknown", () => {
    render(
      <SessionLimitsDetail
        limits={makeLimits({ source: "statusline", fetchedAt: null })}
        now={NOW}
      />
    );
    // No lying UI: no empty provenance affordance when there's nothing to show
    // (and no stale caveat — with no capture time there is nothing to date the
    // figures to, so claiming staleness would be as much of an invention as
    // claiming freshness).
    expect(
      screen.queryByTestId("session-limits-provenance")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("session-limits-stale-note")
    ).not.toBeInTheDocument();
  });
});

describe("SessionLimitsNav", () => {
  it("renders nothing without subscription limits", () => {
    const { container: nullContainer } = render(
      <SessionLimitsNav
        now={NOW}
        state={{ status: SessionLimitsStatus.Unavailable }}
      />
    );
    expect(nullContainer).toBeEmptyDOMElement();

    const { container: emptyContainer } = render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(
          makeLimits({
            fiveHour: null,
            sevenDay: null,
            sevenDayOpus: null,
            sevenDaySonnet: null,
            extraUsage: null,
          })
        )}
      />
    );
    expect(emptyContainer).toBeEmptyDOMElement();
  });

  it("renders the clickable trigger when limits exist", () => {
    render(<SessionLimitsNav now={NOW} state={readyState(makeLimits())} />);
    expect(
      screen.getByTestId("session-limits-nav-trigger")
    ).toBeInTheDocument();
    // The accessible name carries the actual figures: an `aria-label` on a
    // button replaces its subtree, so a static label would silence every
    // percentage inside it.
    const trigger = screen.getByTestId("session-limits-nav-trigger");
    expect(trigger).toHaveAttribute(
      "aria-label",
      "Session limits: Current session 42% used, Current week 70% used. View details"
    );
  });

  it("mounts a trigger with visible content for a subset-only snapshot", () => {
    // Per-model-only week: nav must mount AND the trigger must show a bar, not
    // an empty affordance (regression for the empty-drawer-trigger bug).
    render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(
          makeLimits({
            fiveHour: null,
            sevenDay: null,
            sevenDaySonnet: { utilization: 55, resetsAt: null },
          })
        )}
      />
    );
    expect(
      screen.getByTestId("session-limits-nav-trigger")
    ).toBeInTheDocument();
    expect(screen.getByTestId("session-limits-bars")).toBeInTheDocument();
    expect(screen.getByText("Current week, Sonnet")).toBeInTheDocument();
  });

  it("names a window the same in the sidebar and in the drawer", () => {
    // Same window, one click apart. The sidebar used to say "Sonnet week" while
    // the drawer said "Current week, Sonnet", leaving a reader to work out
    // whether they were looking at one figure or two.
    const sonnetOnly = makeLimits({
      fiveHour: null,
      sevenDay: null,
      sevenDaySonnet: { utilization: 55, resetsAt: null },
    });

    const sidebar = render(<SessionLimitsBars limits={sonnetOnly} now={NOW} />);
    const sidebarTitle = sidebar
      .getByTestId("limit-bar")
      .querySelector("span[title]");
    const sidebarName = sidebarTitle?.textContent ?? "";
    // Truncated at ~14rem, so the full name has to stay recoverable on hover.
    expect(sidebarTitle).toHaveAttribute("title", sidebarName);
    sidebar.unmount();

    const drawer = render(
      <SessionLimitsDetail limits={sonnetOnly} now={NOW} />
    );
    expect(drawer.getByText(sidebarName)).toBeInTheDocument();
  });

  it("hides when extra usage is enabled but has no utilization to draw", () => {
    const { container } = render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(
          makeLimits({
            fiveHour: null,
            sevenDay: null,
            sevenDaySonnet: null,
            extraUsage: {
              isEnabled: true,
              monthlyLimitUsd: 20,
              usedCreditsUsd: null,
              utilization: null,
            },
          })
        )}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * PRD-538 R6: the four states must be distinguishable from one another in the
 * rendered output, not merely different internally. Each assertion below pins
 * the state against the state it is most likely to be confused with.
 */
describe("SessionLimitsNav four states", () => {
  it("renders a loading affordance, not bars, while the snapshot is unresolved", () => {
    render(
      <SessionLimitsNav
        now={NOW}
        state={{ status: SessionLimitsStatus.Loading }}
      />
    );
    expect(screen.getByTestId("session-limits-loading")).toBeInTheDocument();
    // The failure this guards: a loading skeleton that renders empty bars is
    // pixel-identical to a real 0%.
    expect(screen.queryByTestId("session-limits-bars")).not.toBeInTheDocument();
    expect(screen.queryByText(USED_PERCENT_RE)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });

  it("places the skeleton in the same box the resolved summary lands in", () => {
    // jsdom does no layout, so the assertion is on the padding contract the two
    // branches share: the trigger carries its own inset, and the loading branch
    // has to mirror it or the whole block shifts the moment data arrives.
    const loading = render(
      <SessionLimitsNav
        now={NOW}
        state={{ status: SessionLimitsStatus.Loading }}
      />
    );
    const skeletonBox = loading.getByTestId(
      "session-limits-loading"
    ).parentElement;
    loading.unmount();

    const ready = render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(makeLimits())}
        timeZone="UTC"
      />
    );
    const trigger = ready.getByTestId("session-limits-nav-trigger");

    for (const padding of ["px-2", "py-1.5"]) {
      expect(skeletonBox?.className).toContain(padding);
      expect(trigger.className).toContain(padding);
    }
  });

  it("hides itself entirely when no subscription credential resolved", () => {
    // The COMMON macOS case (Keychain-only sign-in), not an edge case.
    const { container } = render(
      <SessionLimitsNav
        now={NOW}
        state={{ status: SessionLimitsStatus.Unavailable }}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByTestId("session-limits-loading")
    ).not.toBeInTheDocument();
  });

  it("sets the stale caveat apart from the per-bar reset lines", () => {
    render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(
          makeLimits({ fetchedAt: "2026-07-19T11:20:00.000Z" })
        )}
        timeZone="UTC"
      />
    );
    const note = screen.getByTestId("session-limits-stale-note");
    // Not italic: nothing else in this slice is, so it read as a typographic
    // exception. Weight carries the distinction instead.
    expect(note.className).not.toContain("italic");
    expect(note.className).toContain("font-medium");
    // And it does not butt against the last reset line: the trigger puts its
    // children on the same rhythm the bars already use, rather than the note
    // carrying a margin of its own.
    const trigger = screen.getByTestId("session-limits-nav-trigger");
    expect(trigger.className).toContain("flex-col");
    expect(trigger.className).toContain("gap-2");
    expect(note.className).not.toContain("mt-");
  });

  it("dates a stale snapshot to its capture time instead of showing it as current", () => {
    render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(
          makeLimits({ fetchedAt: "2026-07-19T11:20:00.000Z" })
        )}
        timeZone="UTC"
      />
    );
    const note = screen.getByTestId("session-limits-stale-note");
    expect(note).toHaveTextContent(AS_OF_RE);
    // The datetime is real and machine-readable, not only a relative phrase.
    expect(note).toHaveAttribute("datetime", "2026-07-19T11:20:00.000Z");
    expect(note).toHaveTextContent(ABSOLUTE_DATE_RE);
  });

  it("renders a measured zero as a real zero, distinct from loading", () => {
    render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(
          makeLimits({
            fiveHour: { utilization: 0, resetsAt: "2026-07-19T15:00:00.000Z" },
            sevenDay: { utilization: 0, resetsAt: "2026-07-21T12:00:00.000Z" },
          })
        )}
        timeZone="UTC"
      />
    );
    expect(screen.getByTestId("session-limits-bars")).toBeInTheDocument();
    expect(screen.getAllByText("0% used")).toHaveLength(2);
    // A genuine zero is data: it must NOT borrow the loading affordance.
    expect(
      screen.queryByTestId("session-limits-loading")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("session-limits-stale-note")
    ).not.toBeInTheDocument();
  });

  it("does not caveat a freshly captured snapshot", () => {
    render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(makeLimits())}
        timeZone="UTC"
      />
    );
    expect(
      screen.queryByTestId("session-limits-stale-note")
    ).not.toBeInTheDocument();
  });
});

describe("session-limit accessibility", () => {
  it("gives each bar an accessible name AND a text percentage", () => {
    render(<SessionLimitsBars limits={makeLimits()} now={NOW} />);
    // A bar alone carries no value to a screen reader, so both must exist.
    expect(
      screen.getByRole("progressbar", { name: "Current session: 42% used" })
    ).toBeInTheDocument();
    expect(screen.getByText("42% used")).toBeInTheDocument();
  });

  it("speaks the stale caveat, not just the figures, on the trigger", () => {
    render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(
          makeLimits({ fetchedAt: "2026-07-19T11:20:00.000Z" })
        )}
        timeZone="UTC"
      />
    );
    // The caveat renders INSIDE the trigger, and an aria-label replaces the
    // subtree for name computation — so without this the one user who cannot
    // see the note hears the figures announced as current.
    const trigger = screen.getByTestId("session-limits-nav-trigger");
    const spoken = trigger.getAttribute("aria-label") ?? "";
    expect(spoken).toMatch(AS_OF_RE);
    expect(spoken).toMatch(ABSOLUTE_DATE_RE);
    // Spoken and drawn agree because both read one selector.
    expect(screen.getByTestId("session-limits-stale-note")).toHaveTextContent(
      spoken.slice(spoken.indexOf("As of"), spoken.indexOf(". View details"))
    );
  });

  it("does not invent a caveat on the trigger for a fresh snapshot", () => {
    render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(makeLimits())}
        timeZone="UTC"
      />
    );
    const spoken =
      screen
        .getByTestId("session-limits-nav-trigger")
        .getAttribute("aria-label") ?? "";
    expect(spoken).toContain("Current session 42% used");
    expect(spoken).not.toMatch(AS_OF_RE);
  });

  it("renders reset times as a real datetime, not only a relative string", () => {
    render(
      <SessionLimitsDetail limits={makeLimits()} now={NOW} timeZone="UTC" />
    );
    const session = screen.getByText(RESET_RELATIVE_RE);
    expect(session.tagName).toBe("TIME");
    expect(session).toHaveAttribute("datetime", "2026-07-19T15:00:00.000Z");
    // …and the absolute time is visible, not hidden in an attribute alone.
    expect(session).toHaveTextContent(ABSOLUTE_DATE_RE);
  });

  it("opens a real dialog with a working way out from the nav trigger", async () => {
    const user = userEvent.setup();
    render(
      <SessionLimitsNav
        now={NOW}
        state={readyState(makeLimits())}
        timeZone="UTC"
      />
    );
    await user.click(screen.getByTestId("session-limits-nav-trigger"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Session limits")).toBeInTheDocument();

    // The way out is asserted through the visible Close control rather than the
    // Escape key: vaul drives dismissal off animation/pointer events jsdom never
    // fires, so an Escape assertion here would prove nothing about the real app.
    // The Close button is a keyboard-reachable exit in its own right, and
    // clicking it drives the same `DrawerClose` dismiss. The assertion is on the
    // state transition, not unmounting — the content stays in the DOM until an
    // exit animation jsdom also never runs.
    //
    // Escape and the focus trap ARE verified, just not here: driven against the
    // `Desktop/Shell/Session Limits Nav` Storybook story in a real Chromium,
    // Escape removes the dialog and returns focus to the trigger, and Tab /
    // Shift+Tab cycle only between the provenance control and Close. Deliberately
    // not restated as a jsdom assertion, which would pass without proving it.
    const close = within(dialog).getByRole("button", { name: "Close" });
    await user.click(close);
    await waitFor(() => expect(dialog).toHaveAttribute("data-state", "closed"));
  });
});

/**
 * The fifth state nobody planned for: a utilization that is not a number.
 *
 * Types do not constrain what crosses the IPC boundary, so a null/NaN reaching
 * the renderer is reachable, not theoretical — and the obvious handling (clamp
 * it to 0) produces exactly the fabricated zero this whole ticket exists to
 * prevent. It must read as unknown, not as measured.
 */
describe("a utilization that is not a measurement", () => {
  it("does not render a non-finite utilization as a measured zero", () => {
    render(
      <SessionLimitsBars
        limits={makeLimits({
          fiveHour: { utilization: Number.NaN, resetsAt: null },
        })}
        now={NOW}
      />
    );
    expect(screen.queryByText("0% used")).not.toBeInTheDocument();
    expect(screen.getByText("Usage unknown")).toBeInTheDocument();
    // Progress's own contract: an unrepresentable value is indeterminate, which
    // renders as a hatch rather than as an empty (0%-looking) track.
    expect(
      screen.getByRole("progressbar", {
        name: "Current session: Usage unknown",
      })
    ).toHaveAttribute("data-state", "indeterminate");
  });

  it("holds the unknown bar still instead of sweeping it like a loader", () => {
    render(
      <SessionLimitsBars
        limits={makeLimits({
          fiveHour: { utilization: Number.NaN, resetsAt: null },
        })}
        now={NOW}
      />
    );
    // Indeterminate is honest about the amount; an animated sheen on top of it
    // would claim work is still in flight, which is the loading state this
    // slice separates unknown from. The hatch stays, the sweep does not.
    const unknown = screen.getByRole("progressbar", {
      name: "Current session: Usage unknown",
    });
    expect(
      unknown.querySelector('[data-slot="progress-indicator"]')
    ).toHaveAttribute("data-paused", "true");
    expect(
      unknown.querySelector('[data-slot="progress-sheen"]')
    ).not.toBeInTheDocument();
    // The measured sibling is unaffected — this is not a blanket freeze.
    const measured = screen.getByRole("progressbar", {
      name: "Current week: 70% used",
    });
    expect(
      measured.querySelector('[data-slot="progress-indicator"]')
    ).not.toHaveAttribute("data-paused");
  });

  it("still renders a real zero as a determinate, measured zero", () => {
    render(
      <SessionLimitsBars
        limits={makeLimits({ fiveHour: { utilization: 0, resetsAt: null } })}
        now={NOW}
      />
    );
    expect(screen.getByText("0% used")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Current session: 0% used" })
    ).toHaveAttribute("data-state", "loading");
  });
});

/**
 * The urgency scale, which is the one signal a user near their cap actually
 * reads, and which no jsdom text assertion touches — the percentage string is
 * identical at 74% and at 91%.
 *
 * Tone is asserted through the track class because that is the observable
 * contract `Progress` exposes for it: the prop moves track, fill and hatch
 * together, and the track is present in every state including indeterminate.
 */
describe("the urgency scale", () => {
  function trackFor(utilization: number, usedText: string): string {
    const { unmount } = render(
      <SessionLimitsBars
        limits={makeLimits({ fiveHour: { utilization, resetsAt: null } })}
        now={NOW}
      />
    );
    const bar = screen.getByRole("progressbar", {
      name: `Current session: ${usedText}`,
    });
    const className = bar.className;
    unmount();
    return className;
  }

  it("rests neutral below the warning threshold rather than on the brand accent", () => {
    // These bars sit in the sidebar footer permanently. Spending the loudest
    // colour in the scale on its least urgent state leaves the step up to amber
    // with nothing to say.
    expect(trackFor(0, "0% used")).toContain("bg-muted-foreground/20");
    expect(trackFor(74, "74% used")).toContain("bg-muted-foreground/20");
    expect(trackFor(74, "74% used")).not.toContain("bg-primary/20");
  });

  it("steps to warning at 75 and to destructive at 90", () => {
    expect(trackFor(75, "75% used")).toContain("bg-warning/20");
    expect(trackFor(89, "89% used")).toContain("bg-warning/20");
    expect(trackFor(90, "90% used")).toContain("bg-destructive/20");
    expect(trackFor(100, "100% used")).toContain("bg-destructive/20");
  });

  it("asserts no severity at all for an amount it never measured", () => {
    expect(trackFor(Number.NaN, "Usage unknown")).toContain(
      "bg-muted-foreground/20"
    );
  });
});
