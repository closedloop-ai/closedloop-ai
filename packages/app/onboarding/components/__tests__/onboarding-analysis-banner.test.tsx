import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BANNER_EXIT_ANIMATION_MS,
  OnboardingAnalysisBanner,
} from "../onboarding-analysis-banner";

/**
 * ISS-8346. The banner is the promoted Web Master v2 design with its invented
 * `TOTAL_SESSIONS = 270` replaced by real props — every count is independently
 * omitted when the host has not measured it, and the fixed-position banner's
 * height report is what keeps it from overlapping the content beneath it.
 */
const RATIO_TEXT = /^[\d,]+ \/ [\d,]+$/;

describe("OnboardingAnalysisBanner", () => {
  // Unconditional, never the last line of the case that installed them: an
  // assertion throwing mid-case would otherwise leak a frozen clock into every
  // later test in this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the default headline and announces an optional host stage without the counter", () => {
    const props = { active: true, analyzed: 5, found: 10, percent: 50 };
    const { rerender } = render(<OnboardingAnalysisBanner {...props} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Analyzing session records");
    expect(status.contains(screen.getByText("5 / 10"))).toBe(false);

    rerender(<OnboardingAnalysisBanner {...props} label="Opening store" />);
    expect(status.textContent).toBe("Opening store");
    rerender(<OnboardingAnalysisBanner {...props} label={null} />);
    expect(status.textContent).toBe("Analyzing session records");
  });

  it("renders the analyzed/found ratio when both counts are measured", () => {
    render(
      <OnboardingAnalysisBanner
        active
        analyzed={1234}
        found={5678}
        percent={22}
      />
    );

    expect(screen.getByText("1,234 / 5,678")).not.toBeNull();
  });

  it.each([null, 40])(
    "sweeps at %s, and renders no control beside the counter (ISS-10940)",
    (percent) => {
      // Queried by ROLE ALONE, never by the retired label: an absence assertion
      // naming deleted copy is satisfied by a locator that has simply stopped
      // matching anything. The bar assertions beside it prove this render
      // produced the bar the control used to sit on.
      render(
        <OnboardingAnalysisBanner
          active
          analyzed={5}
          found={10}
          percent={percent}
        />
      );
      const bar = screen.getByRole("progressbar");
      expect(screen.getByText("5 / 10")).not.toBeNull();
      expect(bar.querySelector('[data-slot="progress-sheen"]')).not.toBeNull();
      expect(bar.getAttribute("aria-valuenow")).toBe(
        percent === null ? null : String(percent)
      );
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    }
  );

  it("renders no counter when either count is unmeasured, paired against a measured control", () => {
    const { unmount: unmountNoAnalyzed } = render(
      <OnboardingAnalysisBanner
        active
        analyzed={null}
        found={10}
        percent={50}
      />
    );
    expect(screen.queryByText(RATIO_TEXT)).toBeNull();
    unmountNoAnalyzed();

    const { unmount: unmountNoFound } = render(
      <OnboardingAnalysisBanner
        active
        analyzed={10}
        found={null}
        percent={50}
      />
    );
    expect(screen.queryByText(RATIO_TEXT)).toBeNull();
    unmountNoFound();

    // Positive control: the same query, with both counts supplied, finds it.
    render(
      <OnboardingAnalysisBanner active analyzed={5} found={10} percent={50} />
    );
    expect(screen.getByText("5 / 10")).not.toBeNull();
  });

  /**
   * ISS-10492, whitlockk review 2026-09-17. The offset is released when the bar
   * LEAVES THE SCREEN, not when `active` goes false — those are 300ms apart,
   * and clearing at the first of them dropped the `SidebarInset` offset out
   * from under a bar that was still painted, so the topbar jumped up behind
   * the exit animation.
   *
   * Both halves are pinned here deliberately: the hold through the animation
   * is the behaviour that regressed, and the clear at unmount is what stops a
   * fix for it from stranding the shell permanently offset.
   */
  it("holds its reported height through the exit animation and clears it at unmount", () => {
    vi.useFakeTimers();
    const onHeightChange = vi.fn();
    const { rerender } = render(
      <OnboardingAnalysisBanner
        active
        analyzed={5}
        found={10}
        onHeightChange={onHeightChange}
        percent={50}
      />
    );

    // jsdom performs no layout, so only the type of the report is provable
    // here, not a specific pixel value.
    expect(onHeightChange).toHaveBeenCalledWith(expect.any(Number));

    onHeightChange.mockClear();
    rerender(
      <OnboardingAnalysisBanner
        active={false}
        analyzed={5}
        found={10}
        onHeightChange={onHeightChange}
        percent={50}
      />
    );

    // Mid-animation: the bar is still on screen, so the offset beneath it must
    // not have been released.
    expect(screen.getByRole("status", { hidden: true })).not.toBeNull();
    expect(onHeightChange).not.toHaveBeenCalledWith(0);

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_ANIMATION_MS);
    });

    expect(screen.queryByRole("status", { hidden: true })).toBeNull();
    expect(onHeightChange).toHaveBeenCalledWith(0);
  });

  describe("exit animation", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps the banner mounted through the exit animation, then unmounts it", () => {
      vi.useFakeTimers();
      const { rerender } = render(
        <OnboardingAnalysisBanner active analyzed={5} found={10} percent={50} />
      );
      expect(screen.getByRole("status")).not.toBeNull();

      rerender(
        <OnboardingAnalysisBanner
          active={false}
          analyzed={5}
          found={10}
          percent={50}
        />
      );
      // Still mounted mid-animation — going inactive must not unmount it
      // immediately. It is `aria-hidden` while exiting, so the query must
      // reach into the inaccessible tree to find it.
      expect(screen.getByRole("status", { hidden: true })).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(BANNER_EXIT_ANIMATION_MS);
      });

      expect(screen.queryByRole("status", { hidden: true })).toBeNull();
    });
  });
});

/**
 * ISS-10492 — the height report must not be a layout feedback loop.
 *
 * The effect had no dep array and no change check, so it re-ran after every
 * render, disconnecting and re-observing the surface each time;
 * `ResizeObserver.observe` fires an initial callback on every `observe`, so
 * every render scheduled another report, which set state in the host, which
 * rendered, which re-observed. On `desktop-e2e` that pegged the renderer and
 * turned two seconds-scale specs into fifteen-minute hangs.
 */
describe("height reporting is bounded", () => {
  let observers: { callback: ResizeObserverCallback; observeCount: number }[] =
    [];
  let measuredHeight = 36;
  let restoreRect: (() => void) | undefined;
  let restoreObserver: (() => void) | undefined;

  beforeEach(() => {
    observers = [];
    measuredHeight = 36;
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getRect() {
      return {
        bottom: measuredHeight,
        height: measuredHeight,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0,
      } as DOMRect;
    };
    restoreRect = () => {
      Element.prototype.getBoundingClientRect = originalRect;
    };
    const originalObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private readonly record: {
        callback: ResizeObserverCallback;
        observeCount: number;
      };
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, observeCount: 0 };
        observers.push(this.record);
      }
      observe() {
        this.record.observeCount += 1;
      }
      unobserve() {
        return;
      }
      disconnect() {
        return;
      }
    } as unknown as typeof ResizeObserver;
    restoreObserver = () => {
      globalThis.ResizeObserver = originalObserver;
    };
  });

  afterEach(() => {
    restoreRect?.();
    restoreObserver?.();
  });

  function fireObservers() {
    act(() => {
      for (const observer of observers) {
        observer.callback([], {} as ResizeObserver);
      }
    });
  }

  it("observes once across re-renders and reports only when the height changes", () => {
    const onHeightChange = vi.fn();
    const props = {
      active: true,
      analyzed: 5,
      found: 10,
      onHeightChange,
    };
    const { rerender } = render(
      <OnboardingAnalysisBanner {...props} percent={10} />
    );

    expect(onHeightChange).toHaveBeenCalledWith(36);
    const reportsAfterMount = onHeightChange.mock.calls.length;

    // The host re-renders constantly while analysis runs — the percentage moves
    // on every tick. None of that may re-arm the observer.
    for (const percent of [20, 30, 40, 50, 60]) {
      rerender(<OnboardingAnalysisBanner {...props} percent={percent} />);
      fireObservers();
    }

    expect(observers).toHaveLength(1);
    expect(observers[0].observeCount).toBe(1);
    expect(onHeightChange.mock.calls.length).toBe(reportsAfterMount);

    // A real resize still reports. The loop is what is gone, not the contract.
    measuredHeight = 48;
    fireObservers();
    expect(onHeightChange).toHaveBeenLastCalledWith(48);
  });

  /**
   * ISS-10484 (design review of #7981). The host drops its content and its
   * `active` in the same tick, but the bar stays mounted for the exit animation —
   * so rendering the live props made it fall back to DEFAULT_LABEL, i.e. the bar
   * claimed analysis had just STARTED on its way out.
   */
  it("keeps stating what it last said while it animates out, not the default", () => {
    vi.useFakeTimers();
    const props = {
      analyzed: 5,
      counterUnit: "source files",
      found: 5,
      label: "5 saved sessions still available",
      percent: 100,
    };
    const { rerender } = render(
      <OnboardingAnalysisBanner {...props} active={true} />
    );
    expect(screen.getByText("5 saved sessions still available")).toBeTruthy();

    // Content and `active` drop together, exactly as the desktop pass's idle
    // object does.
    rerender(
      <OnboardingAnalysisBanner
        active={false}
        analyzed={null}
        found={null}
        label={null}
        percent={null}
      />
    );

    // Still on screen, still saying the same thing — and NOT the default.
    expect(screen.getByText("5 saved sessions still available")).toBeTruthy();
    expect(screen.queryByText("Analyzing session records")).toBeNull();
    expect(screen.getByText("5 / 5 source files")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_ANIMATION_MS);
    });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  /**
   * THE OTHER HOST (tamsinb review of #7981). The web derivation's `active` has
   * `percent < 100` as one of its terms, so a finished import goes inactive on the
   * very frame that reaches 100% with both counts equal — while still STATING all
   * of it. A whole-frame freeze discarded that frame and slid a completed import
   * out at its last sub-100 position, which is a number the reader never gets to
   * see corrected.
   *
   * Both directions are pinned in one case on purpose: the sub-100 frame is what
   * the render must have moved OFF, and the 100% frame is what it must have moved
   * TO, so a hold that simply ignored the exit could not satisfy it.
   */
  it("keeps stating live content while it animates out when the host is still stating it", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <OnboardingAnalysisBanner
        active
        analyzed={261}
        found={270}
        percent={97}
      />
    );
    expect(screen.getByText("261 / 270")).toBeTruthy();

    // The web derivation's completion frame: inactive, and complete.
    rerender(
      <OnboardingAnalysisBanner
        active={false}
        analyzed={270}
        found={270}
        percent={100}
      />
    );

    expect(screen.getByText("270 / 270")).toBeTruthy();
    expect(screen.queryByText("261 / 270")).toBeNull();
    expect(
      screen
        .getByRole("progressbar", { hidden: true })
        .getAttribute("aria-valuenow")
    ).toBe("100");

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_ANIMATION_MS);
    });
    expect(screen.queryByRole("progressbar", { hidden: true })).toBeNull();
  });

  it("re-measures once the surface exists, when active flips on after mount", () => {
    const onHeightChange = vi.fn();
    const props = { analyzed: 5, found: 10, onHeightChange, percent: 10 };
    const { rerender } = render(
      <OnboardingAnalysisBanner {...props} active={false} />
    );
    expect(onHeightChange).toHaveBeenLastCalledWith(0);

    // `mounted` lags `active` by a render, so an effect keyed on `active` alone
    // measures a surface that is not in the DOM yet and never runs again.
    rerender(<OnboardingAnalysisBanner {...props} active={true} />);
    expect(onHeightChange).toHaveBeenLastCalledWith(36);
  });
});
