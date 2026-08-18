/**
 * @file member-targets-block.test.tsx
 * @description Behavioral coverage for the FEA-4077 member per-machine block.
 * Renders the member view of a pack's install state across the member's own
 * machines and asserts the honest per-target states (installed / not / updatable
 * / offline), the loading / error / empty states, that the block is gated on the
 * member capability (browse-only members are unaffected), and that desktop's
 * local read and the web registered-node read both drive the same rendered
 * states. Behavioral: render, assert the rendered labels/roles; no source scans,
 * no timing.
 */

import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { INSTALL_STATE_LABEL, PackInstallState } from "../../lib/install-state";
import type { PackComponentInstallMatrix } from "../../lib/pack-install-matrix";
import type { PackView } from "../../lib/pack-view";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackDetail } from "../pack-detail";

const MEMBER_CONTEXT = createPacksContext(PacksMode.WebMember);
const ADMIN_CONTEXT = createPacksContext(PacksMode.WebAdmin);

function pack(overrides: Partial<PackView> = {}): PackView {
  return {
    id: "pack-1",
    name: "code",
    verified: true,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    ...overrides,
  };
}

function matrix(
  cells: PackComponentInstallMatrix["cells"]
): PackComponentInstallMatrix[] {
  return [{ componentId: "pack-1", componentName: "code", cells }];
}

function cell(
  computeTargetId: string,
  machineName: string,
  state: PackInstallState,
  harness = "claude"
): PackComponentInstallMatrix["cells"][number] {
  return {
    computeTargetId,
    computeTargetName: machineName,
    harness,
    state,
    installedVersion: null,
    failureReason: null,
  };
}

function renderDetail(node: ReactNode) {
  const nav = createMemoryNavigation({
    initialPath: "/packs/code",
    orgSlug: "org-test",
  });
  return render(
    <NavigationProvider adapter={nav.adapter}>{node}</NavigationProvider>
  );
}

function machinesRegion() {
  return screen.getByRole("region", { name: "Your machines" });
}

describe("MemberTargetsBlock (FEA-4077)", () => {
  it("renders one honest install state per machine from the registered-node matrix", () => {
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        pack={pack({
          installMatrix: matrix([
            cell("n1", "Laptop", PackInstallState.Installed),
            cell("n2", "Desktop", PackInstallState.NotInstalled),
          ]),
        })}
      />
    );

    const region = machinesRegion();
    expect(within(region).getByText("Laptop")).toBeInTheDocument();
    expect(within(region).getByText("Desktop")).toBeInTheDocument();
    expect(
      within(region).getByText(INSTALL_STATE_LABEL[PackInstallState.Installed])
    ).toBeInTheDocument();
    expect(
      within(region).getByText(
        INSTALL_STATE_LABEL[PackInstallState.NotInstalled]
      )
    ).toBeInTheDocument();
  });

  it("renders an updatable machine with the honest 'Update available' label", () => {
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        pack={pack({
          installMatrix: matrix([
            cell("n1", "Laptop", PackInstallState.Updatable),
          ]),
        })}
      />
    );
    expect(
      within(machinesRegion()).getByText(
        INSTALL_STATE_LABEL[PackInstallState.Updatable]
      )
    ).toBeInTheDocument();
  });

  it("shows an offline machine honestly, not as installed or absent", () => {
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        pack={pack({
          installMatrix: matrix([
            cell("n1", "Laptop", PackInstallState.Offline),
          ]),
        })}
      />
    );
    const region = machinesRegion();
    expect(within(region).getByText("Laptop")).toBeInTheDocument();
    expect(
      within(region).getByText(INSTALL_STATE_LABEL[PackInstallState.Offline])
    ).toBeInTheDocument();
  });

  it("reflects desktop local install state (this machine) when no matrix is loaded", () => {
    renderDetail(
      <PackDetail
        context={createPacksContext(PacksMode.DesktopTeam)}
        pack={pack({ installedHarnesses: ["claude"], installMatrix: null })}
      />
    );
    const region = machinesRegion();
    expect(within(region).getByText("This machine")).toBeInTheDocument();
    expect(
      within(region).getByText(INSTALL_STATE_LABEL[PackInstallState.Installed])
    ).toBeInTheDocument();
  });

  it("renders a skeleton while the per-machine read is in flight", () => {
    renderDetail(
      <PackDetail context={MEMBER_CONTEXT} memberTargetsLoading pack={pack()} />
    );
    expect(screen.getByTestId("member-targets-skeleton")).toBeInTheDocument();
  });

  it("renders an honest error state, never a silent 'not installed'", () => {
    renderDetail(
      <PackDetail context={MEMBER_CONTEXT} memberTargetsError pack={pack()} />
    );
    expect(
      within(machinesRegion()).getByText("Couldn't load your machines")
    ).toBeInTheDocument();
  });

  it("renders an honest empty state when the member has no machines", () => {
    // Web member with no registered nodes → no matrix, and no local install
    // state (web has no local machine) → the local fallback produces a
    // not-installed row, so an explicitly empty matrix is used to model "no
    // nodes" for the web read.
    renderDetail(
      <PackDetail
        context={MEMBER_CONTEXT}
        pack={pack({ harnesses: [], installMatrix: [] })}
      />
    );
    expect(
      within(machinesRegion()).getByText("No machines yet")
    ).toBeInTheDocument();
  });

  it("does not render the block for the admin surface (browse/manage, not per-machine)", () => {
    renderDetail(
      <PackDetail
        context={ADMIN_CONTEXT}
        pack={pack({
          installMatrix: matrix([
            cell("n1", "Laptop", PackInstallState.Installed),
          ]),
        })}
      />
    );
    expect(
      screen.queryByRole("region", { name: "Your machines" })
    ).not.toBeInTheDocument();
  });
});
