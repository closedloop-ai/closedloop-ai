/**
 * @description The flag gate on the opt-in distributions banner (operator
 * instruction, 2026-09-30 — the prompt was surfacing in first-run demos), and
 * the race the gate must not lose.
 *
 * The flag is read INSIDE the banner, below its subscription to the one-shot
 * `desktop:distributions:opt-in-available` push, precisely so a PostHog
 * assignment that is still PENDING cannot unmount the listener. These cases
 * drive the assignment the way the renderer actually sees it — closed while
 * PENDING, then open — and emit the push in the window the earlier mount gate
 * dropped it in. Every absence assertion carries its own presence
 * counterfactual in the same case, so a banner that rendered nothing either way
 * cannot satisfy one.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  DistributionMode,
  type OptInDistributionDto,
} from "@repo/api/src/types/distribution";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { DISTRIBUTION_OPT_IN_BANNER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptInDistributionsBanner } from "../opt-in-distributions-banner";

const DISTRIBUTION: OptInDistributionDto = {
  id: "dist-1",
  mode: DistributionMode.OptIn,
  catalogItem: {
    id: "cat-1",
    name: "RTK",
    targetKind: AgentComponentKind.Plugin,
  },
};

const OTHER_DISTRIBUTION: OptInDistributionDto = {
  id: "dist-2",
  mode: DistributionMode.OptIn,
  catalogItem: {
    id: "cat-2",
    name: "Gardener",
    targetKind: AgentComponentKind.Skill,
  },
};

const DISMISS_LABEL = "Dismiss";

type Listener = (distributions: OptInDistributionDto[]) => void;

const requestedKeys: string[] = [];

/**
 * Drive the banner through the real feature-flag port. `enabled` stands in for
 * the resolved PostHog assignment: `false` is both "off for this user" and "not
 * resolved yet", which is exactly the conflation that makes the race possible.
 */
function FlaggedBanner({ enabled }: Readonly<{ enabled: boolean }>) {
  const adapter = useMemo(
    () => ({
      useFeatureFlagEnabled: (key: string) => {
        requestedKeys.push(key);
        return key === DISTRIBUTION_OPT_IN_BANNER_FEATURE_FLAG_KEY && enabled;
      },
    }),
    [enabled]
  );
  return (
    <FeatureFlagAdapterProvider adapter={adapter}>
      <OptInDistributionsBanner />
    </FeatureFlagAdapterProvider>
  );
}

/**
 * Stand in for the main-process push and hand back its emitter, so a case can
 * deliver a distribution in the window it chooses.
 */
function installDesktopApi(): {
  emit: (distributions: OptInDistributionDto[]) => void;
  subscriberCount: () => number;
} {
  const listeners: Listener[] = [];
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      onDistributionsOptInAvailable: (listener: Listener) => {
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
      db: {
        declineDistribution: vi.fn(() => Promise.resolve()),
      },
    },
    writable: true,
  });
  return {
    emit: (distributions) => {
      for (const listener of listeners) {
        act(() => listener(distributions));
      }
    },
    subscriberCount: () => listeners.length,
  };
}

afterEach(() => {
  requestedKeys.length = 0;
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "desktopApi");
});

describe("OptInDistributionsBanner feature gate", () => {
  it("still renders a push that arrived while the assignment was PENDING", () => {
    const { emit, subscriberCount } = installDesktopApi();

    const { rerender } = render(<FlaggedBanner enabled={false} />);
    // The push wins the race: it lands before PostHog answers.
    emit([DISTRIBUTION]);

    expect(subscriberCount()).toBe(1);
    expect(screen.queryByTestId(`opt-in-row-${DISTRIBUTION.id}`)).toBeNull();

    // PostHog answers: enabled. Nothing re-pushes — main sends this once per
    // reconcile — so the row can only appear if the snapshot was captured while
    // the flag still read closed.
    rerender(<FlaggedBanner enabled={true} />);

    expect(screen.getByTestId(`opt-in-row-${DISTRIBUTION.id}`)).toBeTruthy();
  });

  it("renders nothing at all with the flag off, even when a distribution arrives", () => {
    const { emit } = installDesktopApi();

    const { container, rerender } = render(<FlaggedBanner enabled={false} />);
    emit([DISTRIBUTION]);

    expect(screen.queryByTestId("opt-in-banner")).toBeNull();
    expect(screen.queryByTestId(`opt-in-row-${DISTRIBUTION.id}`)).toBeNull();
    // No wrapper, no empty `role="status"` region — the off state paints nothing.
    expect(container.innerHTML).toBe("");
    expect(screen.queryAllByRole("status")).toHaveLength(0);

    // Counterfactual in the same case and the same queries: this fixture WOULD
    // have rendered, so the absences above are the flag's doing.
    rerender(<FlaggedBanner enabled={true} />);

    expect(screen.getByTestId("opt-in-banner")).toBeTruthy();
    expect(screen.getByTestId(`opt-in-row-${DISTRIBUTION.id}`)).toBeTruthy();
    expect(screen.queryAllByRole("status")).not.toHaveLength(0);
  });

  it("keeps pending rows and handled ids across an account switch", () => {
    const { emit } = installDesktopApi();

    const { rerender } = render(<FlaggedBanner enabled={true} />);
    emit([DISTRIBUTION, OTHER_DISTRIBUTION]);

    fireEvent.click(
      within(screen.getByTestId(`opt-in-row-${DISTRIBUTION.id}`)).getByRole(
        "button",
        { name: DISMISS_LABEL }
      )
    );
    expect(screen.queryByTestId(`opt-in-row-${DISTRIBUTION.id}`)).toBeNull();
    expect(
      screen.getByTestId(`opt-in-row-${OTHER_DISTRIBUTION.id}`)
    ).toBeTruthy();

    // Account switch: the assignment resets to PENDING, so the flag reads
    // closed again.
    rerender(<FlaggedBanner enabled={false} />);
    expect(
      screen.queryByTestId(`opt-in-row-${OTHER_DISTRIBUTION.id}`)
    ).toBeNull();

    // Resolved again for the new account. `pending` survived without any
    // re-push...
    rerender(<FlaggedBanner enabled={true} />);
    expect(
      screen.getByTestId(`opt-in-row-${OTHER_DISTRIBUTION.id}`)
    ).toBeTruthy();

    // ...and so did `handledIds`: the reconcile re-pushes both and the row the
    // user already dismissed stays suppressed.
    emit([DISTRIBUTION, OTHER_DISTRIBUTION]);
    expect(screen.queryByTestId(`opt-in-row-${DISTRIBUTION.id}`)).toBeNull();
    expect(
      screen.getByTestId(`opt-in-row-${OTHER_DISTRIBUTION.id}`)
    ).toBeTruthy();
  });

  it("reads exactly the distribution-opt-in-banner key", () => {
    installDesktopApi();

    render(<FlaggedBanner enabled={false} />);

    expect(requestedKeys).toContain(
      DISTRIBUTION_OPT_IN_BANNER_FEATURE_FLAG_KEY
    );
  });
});
