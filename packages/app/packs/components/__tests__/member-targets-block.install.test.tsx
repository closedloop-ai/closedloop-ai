/**
 * @file member-targets-block.install.test.tsx
 * @description Behavioral coverage for the ISS-5125 ACT half of the member
 * per-machine block, driven through the PRODUCTION entry point (`PackDetail`,
 * the only thing that renders the block) rather than the block in isolation —
 * so the `memberTargetsInstall` prop threading through
 * `PacksWorkspace → PackDetail → MemberTargetsBlock` is covered too, and
 * deleting a link in that chain fails a test.
 *
 * The load-bearing assertions are the ones about what the member is offered:
 * that the affordance is ABSENT by default (the flag-off / read-only path this
 * ships behind), that a click dispatches the exact (machine × harness) the row
 * belongs to, that offline / unsupported rows explain themselves instead of
 * silently lacking a button, and that an ambiguous outcome withdraws the button
 * so a member cannot retry an install that may already be running.
 */

import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { PackInstallState } from "../../lib/install-state";
import { MemberInstallAction } from "../../lib/member-install-action";
import { MemberInstallDispatchTone } from "../../lib/member-install-dispatch-copy";
import type { PackComponentInstallMatrix } from "../../lib/pack-install-matrix";
import type { PackView } from "../../lib/pack-view";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import type { MemberTargetsInstall } from "../member-targets-block";
import { memberInstallCellKey } from "../member-targets-block";
import { PackDetail } from "../pack-detail";

const MEMBER_CONTEXT = createPacksContext(PacksMode.WebMember);

// Module-level per the repo's `useTopLevelRegex` convention — a regex literal
// rebuilt inside a matcher on every query is the rule Ultracite enforces.
const INSTALL_BUTTON_NAME = /install/i;
const OFFLINE_REASON_TEXT = /ci-runner is offline/i;
const AMBIGUOUS_OUTCOME_TEXT = /we couldn't confirm it started/i;

function pack(cells: PackComponentInstallMatrix["cells"]): PackView {
  return {
    id: "pack-1",
    name: "release-captain",
    verified: false,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    installMatrix: [
      { componentId: "pack-1", componentName: "release-captain", cells },
    ],
  };
}

function cell(
  computeTargetId: string,
  computeTargetName: string,
  state: PackInstallState,
  harness = "claude"
): PackComponentInstallMatrix["cells"][number] {
  return {
    computeTargetId,
    computeTargetName,
    harness,
    state,
    installedVersion: null,
    failureReason: null,
  };
}

function renderDetail(node: ReactNode) {
  const nav = createMemoryNavigation({
    initialPath: "/packs/release-captain",
    orgSlug: "org-test",
  });
  return render(
    <NavigationProvider adapter={nav.adapter}>{node}</NavigationProvider>
  );
}

function machinesRegion() {
  return screen.getByRole("region", { name: "Your machines" });
}

function installHandle(
  overrides: Partial<MemberTargetsInstall> = {}
): MemberTargetsInstall {
  return { onInstall: vi.fn(), ...overrides };
}

describe("member per-machine install affordance (ISS-5125)", () => {
  it("renders NO install control when the surface supplies no install handle", () => {
    // The closed-by-default path: with the flag off the surface passes nothing
    // and the block must be byte-for-byte the FEA-4077 read-only status list.
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        pack={pack([cell("n1", "Laptop", PackInstallState.NotInstalled)])}
      />
    );
    expect(
      within(machinesRegion()).queryByRole("button", {
        name: INSTALL_BUTTON_NAME,
      })
    ).not.toBeInTheDocument();
  });

  it("dispatches the exact machine, harness, and action for the row clicked", async () => {
    const onInstall = vi.fn();
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        memberTargetsInstall={installHandle({ onInstall })}
        pack={pack([
          cell("n1", "Laptop", PackInstallState.Installed, "claude"),
          cell("n2", "Desktop", PackInstallState.NotInstalled, "codex"),
        ])}
      />
    );

    await userEvent.click(
      within(machinesRegion()).getByRole("button", {
        name: "Install release-captain on Desktop for Codex",
      })
    );

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onInstall).toHaveBeenCalledWith({
      computeTargetId: "n2",
      computeTargetName: "Desktop",
      harness: "codex",
      action: MemberInstallAction.Install,
    });
  });

  it("offers Retry, not Install, on a failed row", async () => {
    const onInstall = vi.fn();
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        memberTargetsInstall={installHandle({ onInstall })}
        pack={pack([cell("n1", "Laptop", PackInstallState.Failed)])}
      />
    );

    await userEvent.click(
      within(machinesRegion()).getByRole("button", {
        name: "Retry release-captain on Laptop for Claude",
      })
    );
    expect(onInstall).toHaveBeenCalledWith(
      expect.objectContaining({ action: MemberInstallAction.Retry })
    );
  });

  it("explains an offline machine instead of leaving a blank where a button would be", () => {
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        memberTargetsInstall={installHandle()}
        pack={pack([cell("n1", "ci-runner", PackInstallState.Offline)])}
      />
    );
    const region = machinesRegion();
    expect(region.querySelector("button[aria-label*='ci-runner']")).toBeNull();
    expect(within(region).getByText(OFFLINE_REASON_TEXT)).toBeInTheDocument();
  });

  it("explains an unsupported harness rather than silently omitting the control", () => {
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        memberTargetsInstall={installHandle()}
        pack={pack([cell("n1", "Laptop", PackInstallState.Unsupported)])}
      />
    );
    const region = machinesRegion();
    expect(
      within(region).queryByRole("button", { name: INSTALL_BUTTON_NAME })
    ).not.toBeInTheDocument();
    expect(
      within(region).getByText("This pack can't run on this harness.")
    ).toBeInTheDocument();
  });

  it("disables only the cell whose dispatch is in flight", () => {
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        memberTargetsInstall={installHandle({
          pendingCellKeys: [memberInstallCellKey("n1", "claude")],
        })}
        pack={pack([
          cell("n1", "Laptop", PackInstallState.NotInstalled, "claude"),
          cell("n2", "Desktop", PackInstallState.NotInstalled, "claude"),
        ])}
      />
    );

    const region = machinesRegion();
    expect(
      within(region).getByRole("button", {
        name: "Install release-captain on Laptop for Claude",
      })
    ).toBeDisabled();
    // The sibling machine is untouched — a per-cell key, not one global boolean.
    expect(
      within(region).getByRole("button", {
        name: "Install release-captain on Desktop for Claude",
      })
    ).toBeEnabled();
  });

  it("shows a dispatch outcome on its own cell and withdraws a non-retryable one's button", () => {
    // The ambiguous `Pending` case: the node may already be installing, so the
    // row keeps reading `NotInstalled` but must NOT re-offer the button.
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        memberTargetsInstall={installHandle({
          dispatchByCellKey: {
            [memberInstallCellKey("n1", "claude")]: {
              message:
                "Install sent to Laptop. We couldn't confirm it started.",
              tone: MemberInstallDispatchTone.Pending,
              retryable: false,
            },
          },
        })}
        pack={pack([
          cell("n1", "Laptop", PackInstallState.NotInstalled, "claude"),
          cell("n2", "Desktop", PackInstallState.NotInstalled, "claude"),
        ])}
      />
    );

    const region = machinesRegion();
    expect(
      within(region).getByText(AMBIGUOUS_OUTCOME_TEXT)
    ).toBeInTheDocument();
    expect(
      within(region).queryByRole("button", {
        name: "Install release-captain on Laptop for Claude",
      })
    ).not.toBeInTheDocument();
    // The other machine, which was never dispatched to, keeps its button.
    expect(
      within(region).getByRole("button", {
        name: "Install release-captain on Desktop for Claude",
      })
    ).toBeInTheDocument();
  });

  it("keeps a retryable failure's button so the member can try again", () => {
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        memberTargetsInstall={installHandle({
          dispatchByCellKey: {
            [memberInstallCellKey("n1", "claude")]: {
              message: "ci-runner is offline, so nothing was installed.",
              tone: MemberInstallDispatchTone.Danger,
              retryable: true,
            },
          },
        })}
        pack={pack([cell("n1", "Laptop", PackInstallState.NotInstalled)])}
      />
    );
    expect(
      within(machinesRegion()).getByRole("button", {
        name: "Install release-captain on Laptop for Claude",
      })
    ).toBeInTheDocument();
  });
});
