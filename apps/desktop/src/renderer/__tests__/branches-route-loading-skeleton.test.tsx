/**
 * Regression (FEA-2932): first navigation to `/branches` must show the branches
 * skeleton scaffold while the lazy `BranchesView` chunk loads — NOT the shared
 * blank centered "Loading…" `PageFallback` flashing across the whole body for
 * the ~200ms fetch before cards + table snap in at once.
 *
 * The `BranchesView` mock suspends on a controllable gate so the load window is
 * held open deterministically: while suspended we assert the skeleton (and the
 * absence of the blank fallback text); after the gate releases we assert the
 * real view replaces it.
 */

import { CardDensity } from "@closedloop-ai/design-system/components/ui/card-density";
import {
  restoreTrackStub,
  stubTrackGap,
  stubTrackWidth,
  type TrackStubDescriptors,
} from "@repo/app/shared/components/__tests__/summary-card-track-stub";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderDesktopApp,
  setupAppShellSuite,
  TEST_TIMEOUT_MS,
} from "./app-shell-harness";

// Gate that keeps the mocked BranchesView suspended until the test releases it,
// so the chunk-load fallback stays on screen long enough to assert against.
// `reset()` re-arms a fresh pending promise so each test starts suspended even
// though the mock closure re-reads `branchesGate.promise` at throw time.
const branchesGate = vi.hoisted(() => {
  const gate = {
    settled: false,
    promise: Promise.resolve<void>(undefined),
    release: () => {
      // Replaced by reset() with the resolver for the current promise.
    },
    reset() {
      gate.settled = false;
      gate.promise = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    },
  };
  gate.reset();
  return gate;
});

vi.mock("../components/branches/branches-view", () => ({
  BranchesView: () => {
    if (!branchesGate.settled) {
      // Throwing a promise suspends the nearest boundary — the dedicated
      // Suspense wrapping BranchesView, whose fallback is BranchesLoading.
      throw branchesGate.promise;
    }
    return <div data-testid="mock-branches-view">Branches loaded</div>;
  },
}));

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

describe("Branches route initial navigation", () => {
  // ISS-8118: adopt the shared harness for timeout budgets and lifecycle —
  // asyncUtilTimeout (15 s) < testTimeout (30 s), matchMedia, ResizeObserver,
  // localStorage, desktopApi, and afterEach cleanup. Replaces the bare 15_000
  // per-test timeout with the harness's named TEST_TIMEOUT_MS so the pair of
  // budgets stays decoupled and named.
  setupAppShellSuite();

  beforeEach(() => {
    branchesGate.reset();
  });

  it(
    "shows the branches skeleton, not a blank Loading… canvas, while the chunk loads",
    async () => {
      renderDesktopApp("#/branches");

      // Load window held open: the branches skeleton scaffold is on screen and
      // the shared blank "Loading…" PageFallback is not.
      expect(
        await screen.findByTestId("branches-loading-skeleton")
      ).toBeDefined();
      expect(screen.queryByText("Loading...")).toBeNull();
      expect(screen.queryByTestId("mock-branches-view")).toBeNull();

      // Chunk resolves → the real view replaces the skeleton.
      branchesGate.settled = true;
      branchesGate.release();
      expect(await screen.findByTestId("mock-branches-view")).toBeDefined();
      expect(screen.queryByTestId("branches-loading-skeleton")).toBeNull();
    },
    TEST_TIMEOUT_MS
  );
});

/**
 * ISS-10540 (operator ruling, Tamsin, 2026-09-21): the desktop Branches
 * skeleton row pins the Compact density tier, the same pin the live strip and
 * the Sessions strip carry, so the swap from skeleton to cards does not change
 * the strip's vertical rhythm.
 *
 * The pin is only observable where the MEASURED tier would resolve Comfortable.
 * The shell harness reports `matchMedia` non-matching, which since ISS-5366 puts
 * the tier in its below-`md` fixed-rank regime: a `wrapBelow` row pins two
 * columns, so a 600px track pairs into (600 − 16) / 2 = 292px cells, over the
 * 260px comfortable floor, and an un-pinned row would hand the roomy card back.
 * An unmeasured jsdom row folds to Compact on its own and would pass with the
 * prop deleted.
 */
describe("Branches route skeleton density (ISS-10540)", () => {
  const ROOMY_PAIRED_TRACK_WIDTH = 600;
  let trackStub: TrackStubDescriptors | undefined;

  setupAppShellSuite();

  beforeEach(() => {
    branchesGate.reset();
    trackStub = stubTrackGap();
    stubTrackWidth(ROOMY_PAIRED_TRACK_WIDTH);
  });

  afterEach(() => {
    if (trackStub) {
      restoreTrackStub(trackStub);
      trackStub = undefined;
    }
  });

  it(
    "pins the skeleton strip Compact at a track where the measurement resolves Comfortable",
    async () => {
      renderDesktopApp("#/branches");

      const skeleton = await screen.findByTestId("branches-loading-skeleton");
      const row = skeleton.querySelector<HTMLElement>("[data-density]");
      expect(row).not.toBeNull();
      expect(row?.dataset.density).toBe(CardDensity.Compact);
    },
    TEST_TIMEOUT_MS
  );
});
