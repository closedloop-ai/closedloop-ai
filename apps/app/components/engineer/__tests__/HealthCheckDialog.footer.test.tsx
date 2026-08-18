import { SYSTEM_CHECK_REPAIR_FEATURE_FLAG_KEY } from "@repo/api/src/types/compute-target";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWrapper,
  failingData,
  PRIMARY_BUTTON_CLASS,
  RE_RECHECK_BUTTON,
  RE_REPAIR_BUTTON,
  RE_RUN_ON_CLOUD_BUTTON,
  repairableFailingData,
} from "./fixtures/health-check-dialog-fixtures";

const mockQueryFn = vi.fn();

const mockUseFeatureFlagEnabled = vi.hoisted(() =>
  vi.fn((_key: string) => false)
);

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
}));

vi.mock("@/lib/engineer/queries/health-check", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/engineer/queries/health-check")
    >();
  return {
    ...actual,
    healthCheckOptions: () => ({
      queryKey: ["health-check"],
      queryFn: mockQueryFn,
      staleTime: 30_000,
    }),
  };
});

vi.mock("@/components/system-check/system-check-results", () => ({
  SystemCheckResults: () => <div data-testid="system-check-results" />,
}));

vi.mock("@/lib/engineer/queries/keys", () => ({
  queryKeys: {
    healthCheck: () => ["health-check"],
    repos: () => ["repos"],
  },
}));

vi.mock("@/lib/engineer/queries/repos", () => ({
  updateRepoSettings: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Import after mocks are registered
import { HealthCheckDialog } from "../HealthCheckDialog";

/**
 * The dialog's action row owns one decision: which control leads and which
 * carries the primary weight. It lives in its own suite because that rule is
 * independent of everything the dialog does with check results (ISS-5171).
 */
describe("footer emphasis (ISS-5171)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryFn.mockResolvedValue(failingData);
  });

  async function renderFooter({
    targetUnreachable,
    onRunOnCloud,
    initialData = failingData,
  }: {
    targetUnreachable?: boolean;
    onRunOnCloud?: () => void;
    initialData?: typeof failingData | typeof repairableFailingData;
  }) {
    const Wrapper = createWrapper();
    render(
      <Wrapper>
        <HealthCheckDialog
          initialData={initialData}
          latestVersionOverride={null}
          onCancel={vi.fn()}
          onRunOnCloud={onRunOnCloud}
          targetUnreachable={targetUnreachable}
        />
      </Wrapper>
    );
    await act(async () => {
      // Flush the mount effects the dialog needs before its footer renders.
    });
    return {
      recheck: screen.getByRole("button", { name: RE_RECHECK_BUTTON }),
      runOnCloud: screen.queryByRole("button", {
        name: RE_RUN_ON_CLOUD_BUTTON,
      }),
      repair: screen.queryByRole("button", { name: RE_REPAIR_BUTTON }),
    };
  }

  /**
   * Document-order positions of two footer controls among the rendered buttons.
   *
   * `compareDocumentPosition` answers the same question, but only through a
   * bitmask, and Biome's `noBitwiseOperators` rejects that. A control that never
   * rendered reports `-1`, so the caller's assertions still catch it.
   */
  function getRenderedOrder(first: Element | null, second: Element | null) {
    const buttons: Element[] = screen.getAllByRole("button");

    return {
      firstIndex: first === null ? -1 : buttons.indexOf(first),
      secondIndex: second === null ? -1 : buttons.indexOf(second),
    };
  }

  it("keeps Re-check primary when the target answered with failing checks", async () => {
    // The machine ran the check and reported real failures, so re-checking
    // after fixing them is exactly the right next action.
    const { recheck, runOnCloud } = await renderFooter({
      onRunOnCloud: vi.fn(),
      targetUnreachable: false,
    });

    expect(recheck.className).toContain(PRIMARY_BUTTON_CLASS);
    expect(runOnCloud?.className).not.toContain(PRIMARY_BUTTON_CLASS);
    // Run on Cloud leads; Re-check trails and carries the weight.
    const { firstIndex, secondIndex } = getRenderedOrder(runOnCloud, recheck);

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it("promotes Run on Cloud when the target could not be reached", async () => {
    // Re-check is the least likely control to work here, so the weight and the
    // trailing slot both move to Run on Cloud.
    const { recheck, runOnCloud } = await renderFooter({
      onRunOnCloud: vi.fn(),
      targetUnreachable: true,
    });

    expect(runOnCloud?.className).toContain(PRIMARY_BUTTON_CLASS);
    expect(recheck.className).not.toContain(PRIMARY_BUTTON_CLASS);
    // Re-check leads; Run on Cloud trails and carries the weight.
    const { firstIndex, secondIndex } = getRenderedOrder(recheck, runOnCloud);

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it("keeps Re-check primary with no Cloud control when the fallback is off", async () => {
    // Without `onRunOnCloud` there is no Cloud control to promote, so an
    // unreachable target must not demote the only remaining action.
    const { recheck, runOnCloud } = await renderFooter({
      targetUnreachable: true,
    });

    expect(runOnCloud).toBeNull();
    expect(recheck.className).toContain(PRIMARY_BUTTON_CLASS);
  });

  /**
   * `DialogFooter` is flex-col-reverse below sm, so the LAST child is the
   * rightmost on desktop and the topmost on mobile. Repair therefore has to
   * trail, and four buttons in one row is too many (ISS-5389 review).
   */
  it("puts Repair last and drops Run on Cloud once Repair is on offer", async () => {
    mockUseFeatureFlagEnabled.mockImplementation(
      (key: string) => key === SYSTEM_CHECK_REPAIR_FEATURE_FLAG_KEY
    );
    mockQueryFn.mockResolvedValue(repairableFailingData);

    const { recheck, runOnCloud, repair } = await renderFooter({
      initialData: repairableFailingData,
      onRunOnCloud: vi.fn(),
      targetUnreachable: false,
    });

    expect(repair).not.toBeNull();
    expect(runOnCloud).toBeNull();
    expect(repair?.className).toContain(PRIMARY_BUTTON_CLASS);
    expect(recheck.className).not.toContain(PRIMARY_BUTTON_CLASS);
    // Re-check leads; Repair trails and carries the weight.
    const { firstIndex, secondIndex } = getRenderedOrder(recheck, repair);

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it("leaves Run on Cloud alone when the gateway has nothing to repair", async () => {
    // The flag is ON and the surface is eligible, but every failing row is
    // un-repairable, so `SystemCheckRepairButton` paints nothing. The footer
    // must not reorder around that invisible node.
    mockUseFeatureFlagEnabled.mockImplementation(
      (key: string) => key === SYSTEM_CHECK_REPAIR_FEATURE_FLAG_KEY
    );

    const { recheck, runOnCloud, repair } = await renderFooter({
      onRunOnCloud: vi.fn(),
      targetUnreachable: false,
    });

    expect(repair).toBeNull();
    expect(runOnCloud).not.toBeNull();
    expect(recheck.className).toContain(PRIMARY_BUTTON_CLASS);
  });
});
