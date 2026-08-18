import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { PackInstallState } from "../../lib/install-state";
import type { PackComponentInstallMatrix } from "../../lib/pack-install-matrix";
import type { PackView } from "../../lib/pack-view";
import { mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackDetail } from "../pack-detail";

/**
 * FEA-4081 install-matrix tab gating.
 *
 * The tab must only appear when the pack's own multi-target install matrix is
 * actually loaded (the P1 fix): without it the tab could only ever render "No
 * install targets yet", falsely reading as "installed on zero machines". And a
 * matrix that only carries a CHILD component's cells must not surface under the
 * pack's name (the P2 fix) — `selectPackMatrix` matches on `componentId`, so a
 * missing pack-id match yields no tab rather than another component's data.
 */

const CONTEXT = createPacksContext(PacksMode.WebAdmin);
const BASE_PACK = mockPackViews[0];

function matrixFor(componentId: string): PackComponentInstallMatrix {
  return {
    componentId,
    componentName: "Some component",
    cells: [
      {
        computeTargetId: "ct-1",
        computeTargetName: "parkers-mbp",
        harness: "claude",
        state: PackInstallState.Installed,
        installedVersion: "1.2.3",
      },
    ],
  };
}

function renderPack(pack: PackView) {
  const nav = createMemoryNavigation({
    initialPath: "/packs/code",
    orgSlug: "org-test",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  return render(<PackDetail context={CONTEXT} pack={pack} />, { wrapper });
}

describe("PackDetail install-matrix tab gating (FEA-4081)", () => {
  it("hides the Install matrix tab when the matrix is not loaded", () => {
    renderPack(BASE_PACK);

    // Distribution (the sibling admin tab) still renders, so this is not a
    // capability gate — only the matrix tab is withheld.
    expect(
      screen.getByRole("tab", { name: "Distribution" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Install matrix" })
    ).not.toBeInTheDocument();
  });

  it("shows the Install matrix tab when the pack's own matrix is loaded", () => {
    renderPack({ ...BASE_PACK, installMatrix: [matrixFor(BASE_PACK.id)] });

    expect(
      screen.getByRole("tab", { name: "Install matrix" })
    ).toBeInTheDocument();
  });

  it("hides the tab when only a child-component matrix is present (P2)", () => {
    renderPack({
      ...BASE_PACK,
      installMatrix: [matrixFor("some-other-child-component")],
    });

    // No pack-id match → no matrix → no tab. A child component's cells must not
    // render under the parent pack's name.
    expect(
      screen.queryByRole("tab", { name: "Install matrix" })
    ).not.toBeInTheDocument();
  });
});
