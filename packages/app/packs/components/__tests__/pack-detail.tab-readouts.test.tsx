import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY } from "@repo/api/src/types/insights-loc-terminology-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PackPerformance, PackView } from "../../lib/pack-view";
import { mockPackUsers, mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackDetail } from "../pack-detail";

const ADMIN = createPacksContext(PacksMode.WebAdmin);
const TOKEN_EFFICIENCY = "Token efficiency";

function basePack(): PackView {
  const pack = mockPackViews[0];
  if (pack === undefined) {
    throw new Error("fixture pack missing");
  }
  return pack;
}

function basePerformance(): PackPerformance {
  const performance = basePack().performance;
  if (!performance) {
    throw new Error("fixture pack must carry a performance block");
  }
  return { ...performance };
}

function renderDetail({
  pack,
  tab,
  flags = [],
  disambiguator,
  contentsSlot,
}: {
  pack: PackView;
  tab?: string;
  flags?: string[];
  disambiguator?: string;
  contentsSlot?: React.ReactNode;
}) {
  const nav = createMemoryNavigation({
    initialPath: tab ? `/packs/code?tab=${tab}` : "/packs/code",
    orgSlug: "org-test",
  });
  render(
    <NavigationProvider adapter={nav.adapter}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: flags })}
      >
        <PackDetail
          contentsSlot={contentsSlot}
          context={ADMIN}
          disambiguator={disambiguator}
          pack={pack}
        />
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
}

function tileValue(label: string): string {
  const card = screen.getByText(label).closest("[data-slot='card']");
  const title = card?.querySelector("[data-slot='card-title']");
  if (!title) {
    throw new Error(`the ${label} card rendered no value`);
  }
  return title.textContent?.trim() ?? "";
}

describe("PackDetail header and contents", () => {
  it("shows the disambiguator and a host-supplied contents slot", () => {
    renderDetail({
      pack: basePack(),
      disambiguator: "Agent · v2",
      contentsSlot: <p>Admin components manager</p>,
    });
    expect(screen.getByText("Agent · v2")).toBeInTheDocument();
    expect(screen.getByText("Admin components manager")).toBeInTheDocument();
  });
});

describe("PackDetail team usage tab", () => {
  it("renders the adoption share with its device count and ring", () => {
    const pack = basePack();
    const usage = pack.teamUsage;
    if (!usage) {
      throw new Error("fixture pack must carry team usage");
    }
    renderDetail({
      pack: {
        ...pack,
        teamUsage: {
          ...usage,
          installedCount: 3,
          teamSize: 4,
          deviceCount: 12,
          notInstalled: [{ id: "u-x", name: "Nadia Holdout", initials: "NH" }],
        },
      },
      tab: "usage",
    });
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("75%")).toBeInTheDocument();
    expect(
      within(panel).getByText("of the team · 12 devices")
    ).toBeInTheDocument();
    expect(within(panel).getByText("Not installed (1)")).toBeInTheDocument();
    expect(within(panel).getByText("Nadia Holdout")).toBeInTheDocument();
    const circles = panel.querySelectorAll("svg circle");
    expect(circles).toHaveLength(2);
    const arc = panel.querySelector("circle[stroke-dasharray]");
    const circumference = 2 * Math.PI * RING_RADIUS;
    expect(arc?.getAttribute("r")).toBe(String(RING_RADIUS));
    expect(Number(arc?.getAttribute("stroke-dasharray"))).toBeCloseTo(
      circumference,
      6
    );
    expect(Number(arc?.getAttribute("stroke-dashoffset"))).toBeCloseTo(
      circumference * 0.25,
      6
    );
  });

  it("falls back to a teammate count with no device suffix", () => {
    renderDetail({
      pack: {
        ...basePack(),
        teamUsage: {
          installers: mockPackUsers.slice(0, 2),
          installedCount: 2,
          installTrend: [1, 2],
        },
      },
      tab: "usage",
    });
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("teammates use this")).toBeInTheDocument();
    expect(
      within(panel).queryByText("Not installed", { exact: false })
    ).toBeNull();
    expect(panel.querySelector("circle[stroke-dasharray]")).toBeNull();
  });
});

describe("PackDetail performance tab", () => {
  it("formats a negative token-efficiency delta with its sign", () => {
    renderDetail({
      pack: {
        ...basePack(),
        performance: { ...basePerformance(), tokenEfficiencyDelta: -4.4 },
      },
      tab: "performance",
    });
    expect(tileValue(TOKEN_EFFICIENCY)).toBe("-4%");
    expect(screen.queryByText(LOC_EFFICIENCY_DETAIL)).toBeNull();
  });

  it("uses LOC wording when the terminology flag is on", () => {
    renderDetail({
      pack: basePack(),
      tab: "performance",
      flags: [INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY],
    });
    expect(tileValue(TOKEN_EFFICIENCY)).toBe("+12%");
    expect(screen.getByText(LOC_EFFICIENCY_DETAIL)).toBeInTheDocument();
  });
});

describe("PackDetail distribution tab", () => {
  it("names each target by user, device name, device id, or a fallback", () => {
    const [firstUser] = mockPackUsers;
    if (firstUser === undefined) {
      throw new Error("fixture users missing");
    }
    renderDetail({
      pack: {
        ...basePack(),
        distribution: {
          id: "dist-1",
          mode: DistributionMode.OptIn,
          targetingType: DistributionTargetingType.Specific,
          desiredEnabled: true,
          targetCount: 4,
          installedCount: 1,
          pendingCount: 1,
          failedCount: 2,
          adoptionLoaded: true,
          targetingEntries: [],
          targets: [
            {
              id: "t-user",
              user: firstUser,
              computeTargetName: "ignored-name",
              status: DistributionTargetStatusValue.Installed,
            },
            {
              id: "t-name",
              computeTargetName: "build-box",
              computeTargetId: "ct-ignored",
              status: DistributionTargetStatusValue.Failed,
            },
            {
              id: "t-id",
              computeTargetId: "ct-42",
              status: DistributionTargetStatusValue.Pending,
            },
            {
              id: "t-none",
              status: DistributionTargetStatusValue.Declined,
            },
          ],
        },
      },
      tab: "distribution",
    });
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("Opt-in")).toBeInTheDocument();
    expect(within(panel).getByText("Specific targets")).toBeInTheDocument();
    expect(within(panel).getByText("2 failed")).toBeInTheDocument();
    const rows = within(panel)
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(rows).toEqual([
      `${firstUser.name}Installed`,
      "build-boxFailed",
      "ct-42Pending",
      "Unknown targetDeclined",
    ]);
  });
});

const LOC_EFFICIENCY_DETAIL = "fewer tokens per LOC vs. baseline";

// InstallRing draws a 48px ring with a 4px stroke, so its radius is 22.
const RING_RADIUS = 22;
