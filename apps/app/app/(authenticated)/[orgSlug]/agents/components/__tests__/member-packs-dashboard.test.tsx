import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import type { PackDistribution, PackView } from "@repo/app/packs/lib/pack-view";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberPacksDashboard } from "../member-packs-dashboard";

const mocks = vi.hoisted(() => ({
  useAdminPackViews: vi.fn(),
}));

vi.mock("@repo/app/packs/hooks/use-admin-pack-views", () => ({
  useAdminPackViews: mocks.useAdminPackViews,
}));

function distribution(
  overrides: Partial<PackDistribution> = {}
): PackDistribution {
  return {
    id: "dist-1",
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    targetCount: 1,
    installedCount: 1,
    pendingCount: 0,
    failedCount: 0,
    targetingEntries: [],
    adoptionLoaded: true,
    ...overrides,
  };
}

function pack(overrides: Partial<PackView> = {}): PackView {
  return {
    id: "pack-1",
    name: "Security Baseline",
    publisher: "Platform Eng",
    version: "4.2.0",
    description: "Org security gates",
    verified: false,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    distribution: null,
    performance: null,
    ...overrides,
  };
}

describe("MemberPacksDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the shared skeleton while the catalog is loading", () => {
    mocks.useAdminPackViews.mockReturnValue({
      packViews: [],
      isLoading: true,
      error: null,
    });

    render(<MemberPacksDashboard />);

    expect(screen.getByTestId("member-packs-skeleton")).toBeInTheDocument();
    // The static heading renders above every state.
    expect(screen.getByText("Plugins")).toBeInTheDocument();
  });

  it("renders an honest error state when the catalog read fails", () => {
    mocks.useAdminPackViews.mockReturnValue({
      packViews: [],
      isLoading: false,
      error: new Error("boom"),
    });

    render(<MemberPacksDashboard />);

    expect(screen.getByText("Couldn't load packs")).toBeInTheDocument();
  });

  it("groups packs by source: a required (auto_install) pack under Required by your org", () => {
    mocks.useAdminPackViews.mockReturnValue({
      packViews: [
        pack({
          id: "req",
          name: "Security Baseline",
          distribution: distribution({ mode: DistributionMode.AutoInstall }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<MemberPacksDashboard />);

    const region = screen.getByRole("region", { name: "Your packs" });
    expect(
      within(region).getByText("Required by your org")
    ).toBeInTheDocument();
    expect(within(region).getByText("Security Baseline")).toBeInTheDocument();
  });

  it("shows the honest failed-install strand for a required pack whose push failed", () => {
    mocks.useAdminPackViews.mockReturnValue({
      packViews: [
        pack({
          id: "req-failed",
          name: "Migration Guardrails",
          distribution: distribution({
            mode: DistributionMode.AutoInstall,
            targets: [
              { id: "t1", status: DistributionTargetStatusValue.Failed },
            ],
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<MemberPacksDashboard />);

    expect(screen.getByText("Migration Guardrails")).toBeInTheDocument();
    expect(screen.getByText("Required, install failed")).toBeInTheDocument();
  });
});
