/**
 * Operator instruction: "Documents and Issues shouldn't even show up as menu
 * items under Labs on desktop unless logged in." The sidebar omits exactly the
 * ids in `hiddenNavIds`, so this pins that set against every auth status with
 * the Labs container, Issues and Documents flags ON — the only thing left to
 * hide Issues is the account.
 */
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ArtifactFlag } from "@repo/app/shared/lib/artifact-flags";
import { ShellNavigationRouteId } from "@repo/app/shared/lib/shell-navigation-contract";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../../shared/feature-flags-labs-detail";
import { DESKTOP_SHELL_ROUTE_NAV_IDS, NavId } from "../route-table";
import { SIGNED_IN_ONLY_NAV_IDS, useDesktopNavGates } from "../use-nav-gates";

const auth = vi.hoisted(() => ({
  status: null as DesktopAuthStatus | null,
}));

vi.mock(
  "../../shared-agent-sessions/desktop-auth-provider",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../shared-agent-sessions/desktop-auth-provider")
      >();
    return {
      ...actual,
      useDesktopAuthOptional: () =>
        auth.status === null
          ? null
          : {
              state: {
                status: auth.status,
                userId: null,
                organizationId: null,
              },
            },
    };
  }
);

const ALL_ON_FLAGS = [
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
  ArtifactFlag.Issues,
  ArtifactFlag.Documents,
];

function hiddenNavIds(enabledFlags: string[] = ALL_ON_FLAGS): NavId[] {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        {children}
      </FeatureFlagAdapterProvider>
    );
  }
  return renderHook(() => useDesktopNavGates(), { wrapper: Wrapper }).result
    .current.hiddenNavIds;
}

const NOT_SIGNED_IN_STATUSES = Object.values(DesktopAuthStatus).filter(
  (status) => status !== DesktopAuthStatus.Authenticated
);

describe("signed-in-only Labs nav items", () => {
  beforeEach(() => {
    auth.status = null;
  });

  it("covers Issues and whatever Desktop maps the Documents route to", () => {
    expect(SIGNED_IN_ONLY_NAV_IDS).toContain(NavId.Issues);
    const documentsNavId =
      DESKTOP_SHELL_ROUTE_NAV_IDS[ShellNavigationRouteId.Documents];
    if (documentsNavId !== null) {
      expect(SIGNED_IN_ONLY_NAV_IDS).toContain(documentsNavId);
    }
  });

  it("shows Issues to a signed-in account", () => {
    auth.status = DesktopAuthStatus.Authenticated;
    const hidden = hiddenNavIds();
    expect(hidden).not.toContain(NavId.Issues);
    // Other Labs items are untouched by the account gate.
    expect(hidden).not.toContain(NavId.Insights);
  });

  it.each(NOT_SIGNED_IN_STATUSES)("hides Issues while auth is %s", (status) => {
    auth.status = status;
    const hidden = hiddenNavIds();
    for (const id of SIGNED_IN_ONLY_NAV_IDS) {
      expect(hidden).toContain(id);
    }
    expect(hidden).not.toContain(NavId.Insights);
  });

  it("hides Issues when no auth provider is mounted", () => {
    expect(hiddenNavIds()).toContain(NavId.Issues);
  });

  // Kerensa Whitlock, 2026-10-21 (#9083): every issue detail opens under Documents,
  // so a signed-in account without Documents gets no Issues row either.
  it("hides Issues from a signed-in account while Documents is off", () => {
    auth.status = DesktopAuthStatus.Authenticated;
    const hidden = hiddenNavIds([
      DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
      ArtifactFlag.Issues,
    ]);
    expect(hidden).toContain(NavId.Issues);
    expect(hidden).not.toContain(NavId.Insights);
  });
});
