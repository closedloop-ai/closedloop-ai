import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailCommentsTopbarAction } from "../detail-comments-topbar-action";

const { route, shell } = vi.hoisted(() => ({
  route: { tab: "sessions" },
  shell: { enabled: false },
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => shell.enabled,
}));
vi.mock(
  "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route",
  () => ({
    useArtifactDetailTabRoute: () => ({ activeTab: route.tab }),
  })
);

const HIDE = "Hide comments rail";

function renderAction(ids: { branchId?: string; sessionId?: string }) {
  render(
    <DetailCommentsTopbarAction
      branchCommentsControl={{
        onOpenChange: vi.fn(),
        open: true,
        toggleRef: createRef(),
      }}
      branchId={ids.branchId ?? null}
      sessionId={ids.sessionId ?? null}
    />
  );
  return screen.queryByRole("button", { name: HIDE });
}

describe("DetailCommentsTopbarAction (ISS-12300 D3)", () => {
  afterEach(() => {
    globalThis.localStorage.clear();
    shell.enabled = false;
    route.tab = ArtifactDetailTab.Sessions;
  });

  it.each([
    [ArtifactDetailTab.Sessions, true],
    [ArtifactDetailTab.Details, false],
  ])(
    "with the shell on, shows the Session button on the %s tab: %s",
    (tab, shown) => {
      shell.enabled = true;
      route.tab = tab;
      expect(renderAction({ sessionId: "s-1" }) !== null).toBe(shown);
    }
  );

  it("with the shell off, shows no Session button", () => {
    expect(renderAction({ sessionId: "s-1" })).toBeNull();
  });

  it.each([
    [ArtifactDetailTab.Artifact, true],
    [ArtifactDetailTab.Sessions, true],
    [ArtifactDetailTab.Details, false],
  ])(
    "with the shell on, shows the Branch button on the %s tab: %s",
    (tab, shown) => {
      shell.enabled = true;
      route.tab = tab;
      expect(renderAction({ branchId: "b-1" }) !== null).toBe(shown);
    }
  );

  // tamsinb, #8620: the shell renders no element with the legacy rail's id,
  // so naming it would leave a dangling IDREF.
  it("with the shell on, the Branch button names no controlled element", () => {
    shell.enabled = true;
    route.tab = ArtifactDetailTab.Artifact;
    expect(
      renderAction({ branchId: "b-1" })?.hasAttribute("aria-controls")
    ).toBe(false);
  });

  it("with the shell off, keeps the Branch legacy button on every tab", () => {
    route.tab = ArtifactDetailTab.Details;
    expect(
      renderAction({ branchId: "b-1" })?.getAttribute("aria-controls")
    ).toBe("branch-comments-workspace");
  });
});
