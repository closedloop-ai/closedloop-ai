import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PackView } from "../../lib/pack-view";
import { mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackDetail } from "../pack-detail";

/**
 * ISS-5123 — the "Stop distributing" affordance on the Distribution tab.
 *
 * Promotion to the organization was one-way; this is the control that takes it
 * back. Because it is destructive and org-wide, three things are pinned here:
 * it does not exist unless the surface explicitly supplies the callback (which
 * the closed-by-default flag governs), it does not exist when there is no
 * distribution to withdraw, and it hands back the DISTRIBUTION id rather than
 * the pack id so a pack carrying several distributions cannot withdraw the
 * wrong one.
 */

const CONTEXT = createPacksContext(PacksMode.WebAdmin);
const DISTRIBUTION_ID = "dist-7";
const SECOND_DISTRIBUTION_ID = "dist-8";

function distributedPack(): PackView {
  return {
    ...mockPackViews[0],
    distribution: {
      id: DISTRIBUTION_ID,
      mode: DistributionMode.AutoInstall,
      targetingType: DistributionTargetingType.All,
      desiredEnabled: true,
      targetCount: 3,
      installedCount: 2,
      pendingCount: 1,
      failedCount: 0,
      // The counts above are real (per-member status was loaded), so the badges
      // render rather than the not-loaded fallback.
      adoptionLoaded: true,
      targetingEntries: [],
    },
  };
}

/**
 * A pack carrying two live distributions — reachable through the admin UI,
 * because "Edit distribution" files a NEW distribution rather than editing the
 * existing one in place. `distribution` is the summary fold (the first);
 * `allDistributions` is the unfolded truth.
 */
function multiplyDistributedPack(): PackView {
  const first = distributedPack();
  const second = {
    ...first.distribution,
    id: SECOND_DISTRIBUTION_ID,
    targetingType: DistributionTargetingType.Specific,
  } as NonNullable<PackView["distribution"]>;
  return {
    ...first,
    allDistributions: [
      first.distribution as NonNullable<PackView["distribution"]>,
      second,
    ],
  };
}

function undistributedPack(): PackView {
  return { ...mockPackViews[0], distribution: null };
}

function renderPack(pack: PackView, props: Record<string, unknown> = {}) {
  const nav = createMemoryNavigation({
    initialPath: "/packs/code",
    orgSlug: "org-test",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  return render(<PackDetail context={CONTEXT} pack={pack} {...props} />, {
    wrapper,
  });
}

const DISTRIBUTION_TAB = /distribution/i;
const EDIT_DISTRIBUTION_BUTTON = /edit distribution/i;
const DISTRIBUTE_BUTTON = /^distribute$/i;
const WITHDRAW_BUTTON = { name: /stop distributing/i };

describe("PackDetail withdraw affordance (ISS-5123)", () => {
  it("does not render the control when the surface supplies no withdraw callback", async () => {
    renderPack(distributedPack());
    await userEvent.click(screen.getByRole("tab", { name: DISTRIBUTION_TAB }));

    // The flag-off / no-capability path. The tab itself still renders, so this
    // proves the control is withheld rather than the whole tab being hidden.
    expect(
      screen.getByRole("button", { name: EDIT_DISTRIBUTION_BUTTON })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", WITHDRAW_BUTTON)
    ).not.toBeInTheDocument();
  });

  it("does not render the control when the pack is not distributed", async () => {
    const onWithdrawDistribution = vi.fn();
    renderPack(undistributedPack(), { onWithdrawDistribution });
    await userEvent.click(screen.getByRole("tab", { name: DISTRIBUTION_TAB }));

    // Nothing to withdraw: offering the control here would promise an action
    // that cannot do anything.
    expect(
      screen.getByRole("button", { name: DISTRIBUTE_BUTTON })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", WITHDRAW_BUTTON)
    ).not.toBeInTheDocument();
  });

  it("hands back the distribution id, not the pack id", async () => {
    const onWithdrawDistribution = vi.fn();
    const pack = distributedPack();
    renderPack(pack, { onWithdrawDistribution });
    await userEvent.click(screen.getByRole("tab", { name: DISTRIBUTION_TAB }));

    await userEvent.click(screen.getByRole("button", WITHDRAW_BUTTON));

    expect(onWithdrawDistribution).toHaveBeenCalledWith([DISTRIBUTION_ID]);
    expect(onWithdrawDistribution).not.toHaveBeenCalledWith([pack.id]);
  });

  /**
   * The summary card folds a pack's distributions to the first one, but the
   * confirmation this control opens promises the pack "will no longer be offered
   * to anyone". Handing back only the folded id would leave the sibling
   * distribution reaching its targets and make that promise false, so the control
   * dispatches every live id the pack holds.
   */
  it("hands back EVERY live distribution id when the pack carries more than one", async () => {
    const onWithdrawDistribution = vi.fn();
    renderPack(multiplyDistributedPack(), { onWithdrawDistribution });
    await userEvent.click(screen.getByRole("tab", { name: DISTRIBUTION_TAB }));

    await userEvent.click(screen.getByRole("button", WITHDRAW_BUTTON));

    expect(onWithdrawDistribution).toHaveBeenCalledWith([
      DISTRIBUTION_ID,
      SECOND_DISTRIBUTION_ID,
    ]);
  });

  it("still withdraws the folded distribution when the payload omits the unfolded list", async () => {
    const onWithdrawDistribution = vi.fn();
    const pack = distributedPack();
    // Back-compat: `allDistributions` is additive, so an older payload without
    // it must still withdraw the one distribution the card does know about
    // rather than rendering a control that dispatches nothing.
    expect(pack.allDistributions).toBeUndefined();
    renderPack(pack, { onWithdrawDistribution });
    await userEvent.click(screen.getByRole("tab", { name: DISTRIBUTION_TAB }));

    await userEvent.click(screen.getByRole("button", WITHDRAW_BUTTON));

    expect(onWithdrawDistribution).toHaveBeenCalledWith([DISTRIBUTION_ID]);
  });

  it("disables the control while a withdrawal is in flight", async () => {
    const onWithdrawDistribution = vi.fn();
    renderPack(distributedPack(), {
      onWithdrawDistribution,
      withdrawDistributionPending: true,
    });
    await userEvent.click(screen.getByRole("tab", { name: DISTRIBUTION_TAB }));

    const button = screen.getByRole("button", WITHDRAW_BUTTON);
    expect(button).toBeDisabled();

    // A second click during an in-flight withdrawal must not dispatch again.
    await userEvent.click(button);
    expect(onWithdrawDistribution).not.toHaveBeenCalled();
  });
});
