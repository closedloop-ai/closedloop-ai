/**
 * ISS-10903: the DESKTOP adapter behind `DiagnosticsSurfaceV2` (ISS-10004) —
 * the IPC probe, its polling loop, and the two PostHog gates that decide which
 * local-collector sections this device can offer.
 *
 * The behaviour worth pinning is the COVERAGE read's cost discipline (ISS-6758)
 * and the reconcile that guards it. The coverage read is a full scan plus a
 * temp B-tree, and this host polls every five seconds, so it is requested only
 * while the reader is actually sitting on the Coverage section — never on the
 * gate alone. But that optimisation created its own failure: selecting Coverage
 * while a load is already in flight hits the re-entrancy guard, so the settled
 * payload arrives WITHOUT coverage and the section reports "could not read" — a
 * false measurement-failure claim that would stand until the next poll, or
 * forever with auto-refresh paused. The host reconciles against what the
 * settled load actually asked for; these cases drive that window directly.
 *
 * The clock is pinned throughout because the poll interval is a clock boundary.
 */

import { DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID } from "@repo/app/diagnostics/components/diagnostics-surface-v2";
import {
  DIAGNOSTICS_SECTIONS,
  DiagnosticsSectionId,
} from "@repo/app/diagnostics/lib/diagnostics-sections";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY,
  DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY,
} from "../../../../shared/feature-flags-labs-detail";
import { DiagnosticsSurfaceHost } from "../diagnostics-surface-host";

const AUTO_REFRESH_MS = 5000;

// Shared by the failure cases below so the recovery case's absence
// assertion cannot hold its own copy of the words.
const READ_FAILURE = "store closed";
const COVERAGE_TAB = sectionTabLabel(DiagnosticsSectionId.Coverage);
const WITHHELD_TAB = sectionTabLabel(DiagnosticsSectionId.Withheld);

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

let getDiagnostics: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  getDiagnostics = vi.fn(async () => diagnosticsPayload());
  installDesktopApi();
});

afterEach(() => {
  cleanup();
  // Unconditional: a case that throws must not leave a frozen clock behind.
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("DiagnosticsSurfaceHost — when it reads", () => {
  it("reads once as soon as the page is active", async () => {
    await mount();

    expect(getDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("reads nothing at all while the page is inactive", async () => {
    await mount({ isActive: false });

    expect(getDiagnostics).not.toHaveBeenCalled();

    // Not even on the poll interval: an inactive page costs nothing.
    await advance(AUTO_REFRESH_MS * 2);
    expect(getDiagnostics).not.toHaveBeenCalled();
  });

  it("reads on (re)activation, independent of the poll", async () => {
    const view = await mount({ isActive: false });
    expect(getDiagnostics).not.toHaveBeenCalled();

    await view.rerender({ isActive: true });

    expect(getDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("polls while visible", async () => {
    await mount();
    expect(getDiagnostics).toHaveBeenCalledTimes(1);

    await advance(AUTO_REFRESH_MS);
    expect(getDiagnostics).toHaveBeenCalledTimes(2);

    await advance(AUTO_REFRESH_MS);
    expect(getDiagnostics).toHaveBeenCalledTimes(3);
  });

  it("stops polling when the page goes inactive", async () => {
    const view = await mount();
    await advance(AUTO_REFRESH_MS);
    const settled = getDiagnostics.mock.calls.length;

    await view.rerender({ isActive: false });
    await advance(AUTO_REFRESH_MS * 3);

    expect(getDiagnostics).toHaveBeenCalledTimes(settled);
  });

  it("never overlaps two reads, and never wedges behind the guard", async () => {
    let releaseFirst: (() => void) | null = null;
    getDiagnostics.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(diagnosticsPayload());
        })
    );
    await mount();
    expect(getDiagnostics).toHaveBeenCalledTimes(1);

    // The poll fires while the first read is still in flight: the guard drops it.
    await advance(AUTO_REFRESH_MS);
    expect(getDiagnostics).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(1);
    });

    // The latch released, so the next poll reads normally rather than wedging.
    await advance(AUTO_REFRESH_MS);
    expect(getDiagnostics).toHaveBeenCalledTimes(2);
  });
});

describe("DiagnosticsSurfaceHost — the coverage read's cost discipline", () => {
  it("never asks for coverage while the gate is off", async () => {
    await mount();

    expect(getDiagnostics).toHaveBeenCalledWith({
      includeActivityCoverage: false,
    });
  });

  it("still does not ask for coverage on the gate alone", async () => {
    // ISS-6758: the gate makes the section AVAILABLE; it does not make the read
    // free. A reader sitting on another section must not be charged for it.
    await mount({ coverage: true });

    expect(getDiagnostics).toHaveBeenCalledWith({
      includeActivityCoverage: false,
    });

    await advance(AUTO_REFRESH_MS);
    for (const call of getDiagnostics.mock.calls) {
      expect(call[0]).toEqual({ includeActivityCoverage: false });
    }
  });

  it("asks for coverage once the reader actually selects that section", async () => {
    await mount({ coverage: true });
    expect(getDiagnostics).toHaveBeenLastCalledWith({
      includeActivityCoverage: false,
    });

    await selectSection(COVERAGE_TAB);

    // The other direction of the rule above: the read is charged when, and
    // only when, someone is looking at the section it pays for.
    expect(getDiagnostics).toHaveBeenLastCalledWith({
      includeActivityCoverage: true,
    });
  });

  it("re-reads with coverage when the selection lands mid-flight", async () => {
    let releaseFirst: (() => void) | null = null;
    getDiagnostics.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(diagnosticsPayload());
        })
    );
    await mount({ coverage: true });
    expect(getDiagnostics).toHaveBeenCalledTimes(1);

    // ISS-6758: selecting Coverage while the first read is in flight hits the
    // re-entrancy guard, so this re-fire is DROPPED and the payload about to
    // settle carries no coverage.
    await selectSection(COVERAGE_TAB);
    expect(getDiagnostics).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId(DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID)
    ).toBeTruthy();

    await act(async () => {
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(1);
    });

    // Reconciling against what the settled load actually asked for closes that
    // window: without it the section would claim a failed read until the next
    // poll, or forever with auto-refresh paused.
    expect(getDiagnostics).toHaveBeenCalledTimes(2);
    expect(getDiagnostics).toHaveBeenLastCalledWith({
      includeActivityCoverage: true,
    });

    // And the section leaves its skeleton, which is what the host's
    // settledSections list is for.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      screen.queryByTestId(DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID)
    ).toBeNull();
  });

  it("keeps a failed read from wedging the poll", async () => {
    getDiagnostics.mockRejectedValueOnce(new Error(READ_FAILURE));
    await mount();
    expect(getDiagnostics).toHaveBeenCalledTimes(1);

    // A rejection still settles the load, so the loop keeps its cadence.
    await advance(AUTO_REFRESH_MS);
    expect(getDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("recovers on a later poll after a failed read", async () => {
    getDiagnostics.mockRejectedValueOnce(new Error(READ_FAILURE));
    await mount();

    // Pin the failure first: without it the absence assertion below stays green
    // against a surface that stopped rendering read failures altogether.
    expect(screen.getByText(READ_FAILURE)).toBeTruthy();

    await advance(AUTO_REFRESH_MS);

    // The second read resolved; the surface is no longer standing on a failure.
    expect(getDiagnostics).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(READ_FAILURE)).toBeNull();
  });
});

describe("DiagnosticsSurfaceHost — the section gates", () => {
  it("offers neither gated section with both gates off", async () => {
    await mount();

    // The ungated sections prove the tab role exists here at all, so the two
    // absence assertions below cannot pass because nothing rendered.
    expect(screen.getByRole("tab", { name: "Repos" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: WITHHELD_TAB })).toBeNull();
    expect(screen.queryByRole("tab", { name: COVERAGE_TAB })).toBeNull();
  });

  it("offers the withheld section once its gate is on", async () => {
    await mount({ withheld: true });

    expect(screen.getByRole("tab", { name: "Withheld" })).toBeTruthy();
  });

  it("offers the coverage section once its gate is on", async () => {
    await mount({ coverage: true });

    expect(screen.getByRole("tab", { name: "Coverage" })).toBeTruthy();
  });

  it("offers both sections when both gates are on", async () => {
    await mount({ coverage: true, withheld: true });

    expect(screen.getByRole("tab", { name: "Withheld" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Coverage" })).toBeTruthy();
  });
});

function diagnosticsPayload() {
  return {
    generatedAt: "2026-09-22T00:00:00.000Z",
    repos: [],
    sessions: [],
  };
}

function installDesktopApi(): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      db: { getDiagnostics },
      getLogs: vi.fn(async () => []),
      clearLogs: vi.fn(async () => undefined),
      openLogFile: vi.fn(async () => ({ ok: true })),
      onLogsChanged: vi.fn(() => () => undefined),
    },
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

type MountOptions = {
  isActive?: boolean;
  coverage?: boolean;
  withheld?: boolean;
};

async function mount(options: MountOptions = {}) {
  const enabledFlags: string[] = [];
  if (options.coverage) {
    enabledFlags.push(DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY);
  }
  if (options.withheld) {
    enabledFlags.push(DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY);
  }
  const adapter = createStaticFeatureFlagAdapter({ enabledFlags });
  const tree = (isActive: boolean) => (
    <FeatureFlagAdapterProvider adapter={adapter}>
      <DiagnosticsSurfaceHost isActive={isActive} />
    </FeatureFlagAdapterProvider>
  );
  const utils = render(tree(options.isActive ?? true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  return {
    async rerender(next: MountOptions) {
      await act(async () => {
        utils.rerender(tree(next.isActive ?? true));
        await vi.advanceTimersByTimeAsync(1);
      });
    },
  };
}

// Radix's TabsTrigger selects on mousedown, not on a bare click, so firing
// `click` alone leaves the section unchanged and every assertion about the
// selected read passes against the section that was already open.
async function selectSection(name: string): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(screen.getByRole("tab", { name }));
    await vi.advanceTimersByTimeAsync(1);
  });
}

function sectionTabLabel(sectionId: DiagnosticsSectionId): string {
  const section = DIAGNOSTICS_SECTIONS.find(({ id }) => id === sectionId);
  if (!section) {
    throw new Error(`No Diagnostics section ${sectionId}`);
  }
  return section.label;
}
