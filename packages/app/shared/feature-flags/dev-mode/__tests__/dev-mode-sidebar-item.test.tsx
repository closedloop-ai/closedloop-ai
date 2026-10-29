import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FeatureFlagAdapterProvider } from "../../provider";
import { createStaticFeatureFlagAdapter } from "../../static-feature-flag-adapter";
import {
  DEV_MODE_CUSTOMER_VIEW_SCOPE_NOTE,
  DEV_MODE_STORAGE_KEY,
} from "../dev-mode-contract";
import { DevModeEligibility, DevModeProvider } from "../dev-mode-provider";
import { DevModeSidebarItem } from "../dev-mode-sidebar-item";

/**
 * ISS-9891 — the Labs-row presentation of the dev-mode switch.
 *
 * The design-system `Switch` is deliberately NOT stubbed. This component exists
 * because `DropdownMenuCheckboxItem` cannot leave the menu, so "the replacement
 * announces itself as an operable switch and actually flips the choice" is the
 * whole claim being made, and a stub would assert the stub.
 *
 * The name is written out rather than imported from the constant the component
 * renders: a fixture that reads its expectation off the value it polices agrees
 * with any rename, including a wrong one.
 */
const DEV_MODE_SWITCH_NAME = "Dev mode";

afterEach(() => {
  cleanup();
  localStorage.removeItem(DEV_MODE_STORAGE_KEY);
});

describe("DevModeSidebarItem (ISS-9891)", () => {
  it("renders as an operable switch for an eligible viewer once the rollout flag is on", () => {
    renderSidebarItem({ isEligible: true, rolloutEnabled: true });

    expect(
      screen.getByRole("switch", { name: DEV_MODE_SWITCH_NAME })
    ).toHaveAttribute("aria-checked", "true");
  });

  it("renders nothing for an eligible viewer while the rollout flag is off", () => {
    renderSidebarItem({ isEligible: true, rolloutEnabled: false });

    expect(
      screen.queryByRole("switch", { name: DEV_MODE_SWITCH_NAME })
    ).toBeNull();
  });

  it("renders nothing for a CUSTOMER even with the rollout flag fully on", () => {
    renderSidebarItem({ isEligible: false, rolloutEnabled: true });

    // Differs from the first case in eligibility ALONE, so it cannot pass for
    // the flag-off reason the case above covers.
    expect(
      screen.queryByRole("switch", { name: DEV_MODE_SWITCH_NAME })
    ).toBeNull();
  });

  it("leaves dev mode when toggled, and persists that", async () => {
    renderSidebarItem({ isEligible: true, rolloutEnabled: true });

    await userEvent.click(
      screen.getByRole("switch", { name: DEV_MODE_SWITCH_NAME })
    );

    // The moved control still DOES the thing, it does not merely render: the
    // reported state flips and the choice reaches the store the provider reads
    // back on the next load.
    expect(
      screen.getByRole("switch", { name: DEV_MODE_SWITCH_NAME })
    ).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(DEV_MODE_STORAGE_KEY)).toBe("false");
  });

  it("announces the customer-view scope note as the switch's description", () => {
    renderSidebarItem({ isEligible: true, rolloutEnabled: true });

    // ISS-7835 AC4 travels with the control. `aria-describedby` rather than
    // adjacency, because a paragraph merely next to the switch is routinely
    // skipped — the note has to be reachable FROM the control.
    const noteId = screen
      .getByRole("switch", { name: DEV_MODE_SWITCH_NAME })
      .getAttribute("aria-describedby");
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId ?? "")).toHaveTextContent(
      DEV_MODE_CUSTOMER_VIEW_SCOPE_NOTE
    );
  });
});

function renderSidebarItem({
  isEligible,
  rolloutEnabled,
}: {
  isEligible: boolean;
  rolloutEnabled: boolean;
}) {
  const adapter = createStaticFeatureFlagAdapter({
    enabledFlags: rolloutEnabled ? [DEV_MODE_FLAG_KEY] : [],
  });

  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      <DevModeProvider
        eligibility={eligibilityOf(isEligible)}
        isRolledOut={rolloutEnabled}
      >
        <DevModeSidebarItem />
      </DevModeProvider>
    </FeatureFlagAdapterProvider>
  );
}

/** The two RESOLVED verdicts; the unresolved window is covered in apps/app. */
function eligibilityOf(isEligible: boolean) {
  return isEligible
    ? DevModeEligibility.Eligible
    : DevModeEligibility.Ineligible;
}
