import {
  Progress,
  ProgressTone,
} from "@closedloop-ai/design-system/components/ui/progress";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_BANNER_READY_TEST_ID, UpdateBanner } from "../../UpdateBanner";
import {
  IMPORT_SPLASH_RAIL_SLOT_TEST_ID,
  ImportSplashCompact,
} from "../import-splash-compact";
import {
  CompactTone,
  type ImportSplashCompactState,
} from "../import-splash-compact-state";

const OVERALL_PROGRESS_NAME = /overall import progress/i;
const SHOW_DETAILS_NAME = /show import details/i;
const ANY_PERCENT_TEXT = /%/;
const ANY_COUNT_TEXT = /transcripts/;
const DISMISS_NAME = /^dismiss$/i;
// The travelling highlight the `Progress` primitive renders only while the bar
// is live. Its absence is how a DETERMINATE rail expresses `paused`.
const SHEEN_SELECTOR = '[data-slot="progress-sheen"]';
const PAUSE_IMPORT_NAME = /^pause import$/i;
const RESUME_IMPORT_NAME = /^resume import$/i;

function baseState(
  overrides: Partial<ImportSplashCompactState> = {}
): ImportSplashCompactState {
  return {
    tone: CompactTone.Progress,
    label: "Importing your agent history",
    metrics: "18 / 60 transcripts",
    promoteMetrics: true,
    showRail: true,
    railPct: 30,
    showPause: true,
    paused: false,
    showContinue: false,
    ...overrides,
  };
}

const noop = () => {
  // intentionally empty
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  // Assigning `undefined` would leave the property defined; the alignment case
  // installs it fresh and nothing else in this file expects it to exist.
  Reflect.deleteProperty(window, "desktopApi");
});

describe("ImportSplashCompact (ISS-5258)", () => {
  it("renders the label, the count, Pause, and the expand control", () => {
    render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState()}
      />
    );

    expect(screen.getByText("Importing your agent history")).toBeDefined();
    expect(screen.getByText("18 / 60 transcripts")).toBeDefined();
    expect(
      screen.getByRole("button", { name: PAUSE_IMPORT_NAME })
    ).toBeDefined();
    const rail = screen.getByRole("progressbar", {
      name: OVERALL_PROGRESS_NAME,
    });
    expect(rail.getAttribute("aria-valuenow")).toBe("30");
  });

  it("marks the expand control as a collapsed disclosure", () => {
    render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState()}
      />
    );

    const expand = screen.getByRole("button", { name: SHOW_DETAILS_NAME });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    // Nothing on screen to point at while the panel is unmounted; a dangling
    // aria-controls would be worse than none.
    expect(expand.getAttribute("aria-controls")).toBeNull();
  });

  it("offers Resume and holds the rail when paused", () => {
    render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={true}
        state={baseState({
          tone: CompactTone.Paused,
          label: "Import paused",
          paused: true,
        })}
      />
    );

    expect(screen.getByText("Import paused")).toBeDefined();
    expect(
      screen.getByRole("button", { name: RESUME_IMPORT_NAME })
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: PAUSE_IMPORT_NAME })
    ).toBeNull();
    // The rail must actually be HELD, not merely present. On a DETERMINATE rail
    // (this one has a position) `paused` is observable as the suppressed sheen,
    // not as `data-paused` — the primitive only stamps that attribute on the
    // indeterminate indicator. Without this, a rail that kept travelling through
    // a paused import would still satisfy every assertion above.
    expect(
      screen
        .getByRole("progressbar", { name: OVERALL_PROGRESS_NAME })
        .querySelector(SHEEN_SELECTOR)
    ).toBeNull();
  });

  it("shows the failure without a rail and without a percentage", () => {
    render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState({
          tone: CompactTone.Attention,
          label: "Import didn't finish",
          metrics: "1,503 / 2,452 transcripts",
          showRail: false,
          showPause: false,
          showContinue: true,
        })}
      />
    );

    expect(screen.getByText("Import didn't finish")).toBeDefined();
    expect(screen.getByText("1,503 / 2,452 transcripts")).toBeDefined();
    expect(
      screen.queryByRole("progressbar", { name: OVERALL_PROGRESS_NAME })
    ).toBeNull();
    // The expanded panel's way out survives the collapse.
    expect(screen.getByRole("button", { name: DISMISS_NAME })).toBeDefined();
  });

  it("sweeps the rail when the banner says the work is still moving", () => {
    render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState({ paused: true })}
      />
    );

    // `railPaused` is the banner's call, not `state.paused`: during the
    // post-import maintenance window an earlier pause intent must not freeze a
    // rail the expanded body keeps sweeping. Asserting the sheen is PRESENT is
    // what makes this the real counterpart of the paused case above — a
    // `data-paused` null check passes vacuously here, because the primitive
    // never stamps that attribute on a determinate rail either way.
    const rail = screen.getByRole("progressbar", {
      name: OVERALL_PROGRESS_NAME,
    });
    expect(rail.querySelector(SHEEN_SELECTOR)).not.toBeNull();
  });

  it("renders the indeterminate rail when the position is unknown", () => {
    render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState({
          label: "Scanning your local logs",
          metrics: null,
          railPct: null,
          showPause: false,
        })}
      />
    );

    // Radix drops aria-valuenow for an indeterminate bar, which is exactly the
    // honest answer: an empty determinate track would announce (and look like)
    // 0% done.
    const rail = screen.getByRole("progressbar", {
      name: OVERALL_PROGRESS_NAME,
    });
    expect(rail.getAttribute("aria-valuenow")).toBeNull();
    expect(rail.getAttribute("data-state")).toBe("indeterminate");
  });

  it("prints no count line when no total is known", () => {
    render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState({
          label: "Scanning your local logs",
          metrics: null,
          railPct: null,
          showPause: false,
        })}
      />
    );

    expect(screen.getByText("Scanning your local logs")).toBeDefined();
    expect(screen.queryByText(ANY_PERCENT_TEXT)).toBeNull();
    expect(screen.queryByText(ANY_COUNT_TEXT)).toBeNull();
  });

  it("calls back on expand and on the pause toggle", () => {
    const onExpand = vi.fn();
    const onTogglePause = vi.fn();
    render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={onExpand}
        onTogglePause={onTogglePause}
        railPaused={false}
        state={baseState()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: PAUSE_IMPORT_NAME }));
    fireEvent.click(screen.getByRole("button", { name: SHOW_DETAILS_NAME }));

    expect(onTogglePause).toHaveBeenCalledTimes(1);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

describe("ImportSplashCompact rail weight (ISS-5367)", () => {
  it("lays the rail out beneath the row instead of overlaying the strip edge", () => {
    render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState()}
      />
    );

    const rail = screen.getByRole("progressbar", {
      name: OVERALL_PROGRESS_NAME,
    });
    const slot = screen.getByTestId(IMPORT_SPLASH_RAIL_SLOT_TEST_ID);
    const contentRow = screen
      .getByText("Importing your agent history")
      .closest("div");

    // The rail used to be an `absolute inset-x-0 bottom-0` overlay inside the
    // same box as the label, which is how it escaped the row's padding and bled
    // to both window edges as a second saturated band. Sitting in a SIBLING slot
    // of the content row rather than inside it is the structural difference:
    // restore the overlay and the label's own row contains the rail again.
    expect(contentRow).not.toBeNull();
    expect(contentRow?.contains(rail)).toBe(false);
    expect(slot.contains(rail)).toBe(true);
    expect(slot.parentElement).toBe(contentRow?.parentElement);
  });

  it("reserves the rail's slot in the one state that renders no rail", () => {
    const withRail = render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState()}
      />
    );
    const withoutRail = render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState({
          tone: CompactTone.Attention,
          label: "Import didn't finish",
          showRail: false,
          showPause: false,
          showContinue: true,
        })}
      />
    );

    // Scoped per container: RTL's returned queries are bound to the document
    // body, and both strips are mounted at once so an unscoped lookup matches
    // two slots — which is itself the thing being asserted.
    const occupied = within(withRail.container).getByTestId(
      IMPORT_SPLASH_RAIL_SLOT_TEST_ID
    );
    const reserved = within(withoutRail.container).getByTestId(
      IMPORT_SPLASH_RAIL_SLOT_TEST_ID
    );

    // In flow the rail costs the strip real height, and `showRail` is false in
    // exactly one state (Failed). Without a reserved slot the strip shrinks the
    // instant an import fails and the Sessions list jumps up under the user as
    // the error copy lands. Delete the slot and this is the assertion that goes
    // red — the failed state renders the same box, holding the same height.
    expect(reserved.className).toBe(occupied.className);

    // …and it is genuinely reserved, not a rail smuggled back in. A progressbar
    // sitting invisibly over a failed import is the stalled bar reading as
    // progress that dropping the rail exists to prevent.
    expect(reserved.childElementCount).toBe(0);
    expect(occupied.childElementCount).toBe(1);
  });

  it("keeps the hatch geometry the primitive ships, adding no override", () => {
    const compact = render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState({ railPct: null })}
      />
    );
    const rail = compact.getByRole("progressbar", {
      name: OVERALL_PROGRESS_NAME,
    });

    // The reference: the same primitive, same tone, same indeterminate value,
    // rendered with nothing added.
    const reference = render(
      <Progress
        aria-label="reference"
        paused={false}
        sweep
        tone={RAIL_TONE_FOR_PROGRESS}
        value={null}
      />
    );
    const referenceRail = reference.getByRole("progressbar", {
      name: REFERENCE_RAIL_NAME,
    });

    // ISS-5115's guarantee is a geometric one: the -45deg hatch needs the
    // primitive's own height to clear a full 7px stripe period, or it stops
    // reading as "amount unknown" and starts reading as a dotted rule. ISS-5367
    // reduced this rail's weight by moving and un-squaring it, NOT by shrinking
    // it — so the honest proof is that the rail the strip renders is
    // indistinguishable from the untouched primitive. Any `h-*`, `rounded-*`,
    // `absolute`, or `inset-*` reintroduced at this call site diverges here.
    expect(rail.className).toBe(referenceRail.className);

    // And it is genuinely the indeterminate rendering being protected.
    expect(rail.getAttribute("data-state")).toBe("indeterminate");
    expect(
      rail
        .querySelector(PROGRESS_INDICATOR_SELECTOR)
        ?.className.includes(PROGRESS_HATCH_CLASS)
    ).toBe(true);
  });

  it("ends the strip in the same edge whether or not a rail renders", () => {
    const withRail = render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState()}
      />
    );
    const withoutRail = render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState({
          tone: CompactTone.Attention,
          label: "Import didn't finish",
          showRail: false,
          showPause: false,
          showContinue: true,
        })}
      />
    );

    // The strip's chrome no longer depends on whether a bar happens to be
    // rendering: the rail stopped doubling as the bottom edge, so the hairline
    // is unconditional. Previously these two roots differed, because the border
    // was drawn only in the state that had no rail.
    expect(withRail.container.firstElementChild?.className).toBe(
      withoutRail.container.firstElementChild?.className
    );
  });

  it("starts on the same left edge as the update banner above it", () => {
    installUpdateApi();
    const banner = render(<UpdateBanner />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("desktop:update-status", {
          detail: {
            status: "downloaded",
            updateAvailable: true,
            readyToInstall: true,
            version: "1.2.3",
          },
        })
      );
    });
    const bannerInset = horizontalInsetOf(
      within(banner.container).getByTestId(UPDATE_BANNER_READY_TEST_ID)
    );

    const compact = render(
      <ImportSplashCompact
        onContinue={noop}
        onExpand={noop}
        onTogglePause={noop}
        railPaused={false}
        state={baseState()}
      />
    );
    const compactInset = horizontalInsetOf(
      compact.container.firstElementChild as Element
    );

    // These two regions sit directly on top of each other in the app chrome and
    // the strip alone stepped 8px further in, so nothing lined up down the left
    // edge. Asserted as agreement rather than as a value: change either one and
    // the edge breaks, which is the actual defect.
    expect(bannerInset).not.toBeNull();
    expect(compactInset).toBe(bannerInset);
  });
});

const RAIL_TONE_FOR_PROGRESS = ProgressTone.Default;
const REFERENCE_RAIL_NAME = /reference/i;
const PROGRESS_INDICATOR_SELECTOR = '[data-slot="progress-indicator"]';
const PROGRESS_HATCH_CLASS = "progress-hatch";
// Matched at a class boundary so a `sm:px-*` or `hover:` variant on the same
// element is never mistaken for the resting inset.
const HORIZONTAL_INSET_UTILITY = /(?:^|\s)(px-\S+)/;

function horizontalInsetOf(element: Element): string | null {
  return HORIZONTAL_INSET_UTILITY.exec(element.className)?.[1] ?? null;
}

function installUpdateApi(): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      applyUpdate: vi.fn(async () => undefined),
      moveToApplications: vi.fn(async () => true),
    },
  });
}
