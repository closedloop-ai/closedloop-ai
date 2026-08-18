/**
 * @file member-packs-view.test.tsx
 * @description Adapter tests for the web-member Packs treatment (FEA-4089).
 * Built from the real `GET /distributions` list-response shape (empty
 * `targetStatuses`), these pin the two behaviors the review flagged:
 *  - a `specific` auto_install distribution that names another member does NOT
 *    read as Required for the current member (member-scoped targeting), and
 *  - the member keeps the edit-capable catalog workspace as the "Available"
 *    region, so a member-owned OrgCustom pack can still be edited (FEA-4085
 *    parity) — the passive by-source treatment no longer drops that capability.
 */

import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
  type DistributionDto,
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useCatalogItems: vi.fn(),
  useDistributions: vi.fn(),
  useAuthSnapshot: vi.fn(),
  catalogDashboard: vi.fn(),
}));

// The member adapter drives the real `useAdminPackViews` hook (not a mock) so
// the catalog→PackView fold + specific-targeting scoping are genuinely
// exercised; only its two source reads are stubbed with real DTO shapes.
vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  useCatalogItems: mocks.useCatalogItems,
}));

vi.mock("@repo/app/agents/hooks/use-distributions", () => ({
  useDistributions: mocks.useDistributions,
}));

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: mocks.useAuthSnapshot,
}));

// The edit-capable catalog workspace is heavyweight (its own dialogs + hooks);
// stub it and assert the member view mounts it as the Available region body.
vi.mock("../../../admin/catalog/components/catalog-dashboard", () => ({
  CatalogDashboard: mocks.catalogDashboard,
}));

import { MemberPacksView } from "../member-packs-view";

const CURRENT_USER = "member-me";

function catalogItem(overrides: Partial<CatalogItemDto> = {}): CatalogItemDto {
  return {
    id: "item-1",
    organizationId: "org-1",
    targetKind: "skill",
    source: CatalogItemSource.OrgCustom,
    scope: CatalogItemScope.Org,
    name: "Locale Pack",
    description: "Localization helpers",
    version: "1.0.0",
    sortOrder: 0,
    enabled: true,
    archived: false,
    coaching: false,
    coachingConfig: null,
    parentPackId: null,
    content: null,
    components: [],
    agentSlug: null,
    logoUrl: null,
    createdById: CURRENT_USER,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function distributionDto(
  overrides: Partial<DistributionDto> = {}
): DistributionDto {
  return {
    id: "dist-1",
    organizationId: "org-1",
    catalogItemId: "item-1",
    catalogItem: {
      id: "item-1",
      name: "Locale Pack",
      targetKind: "skill",
      source: CatalogItemSource.OrgCustom,
    },
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    targetingEntries: [],
    // The list read carries NO per-member target statuses — the exact contract
    // shape the review called out.
    targetStatuses: [],
    assetDownloadUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MemberPacksView", () => {
  beforeEach(() => {
    mocks.useCatalogItems.mockReset();
    mocks.useDistributions.mockReset();
    mocks.useAuthSnapshot.mockReset();
    mocks.catalogDashboard.mockReset();
    mocks.catalogDashboard.mockImplementation(
      ({ isAdmin }: { isAdmin: boolean }) => (
        <div data-testid="catalog-dashboard">{`catalog isAdmin=${String(isAdmin)}`}</div>
      )
    );
    mocks.useAuthSnapshot.mockReturnValue({
      isLoaded: true,
      userId: CURRENT_USER,
      orgId: "org-1",
      getToken: () => Promise.resolve(null),
    });
  });

  it("does not mark a specific auto_install distribution targeting another member as Required", () => {
    mocks.useCatalogItems.mockReturnValue({
      data: [catalogItem()],
      isLoading: false,
      error: null,
    });
    mocks.useDistributions.mockReturnValue({
      data: [
        distributionDto({
          targetingType: DistributionTargetingType.Specific,
          targetingEntries: [{ computeTargetId: null, userId: "someone-else" }],
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<MemberPacksView />);

    // The org-wide summary would have marked this Required for everyone; scoped
    // to the current member (not targeted), it must not.
    expect(screen.queryByText("Required by your org")).toBeNull();
    const available = screen.getByRole("region", { name: "Available" });
    expect(available).toBeInTheDocument();
  });

  it("mounts the edit-capable catalog workspace (isAdmin=false) as the Available region — member OrgCustom edit path", () => {
    mocks.useCatalogItems.mockReturnValue({
      data: [catalogItem()],
      isLoading: false,
      error: null,
    });
    mocks.useDistributions.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    render(<MemberPacksView />);

    const available = screen.getByRole("region", { name: "Available" });
    // The member gets the creator-editable catalog workspace, not a passive
    // list — restoring the dropped member-owned OrgCustom edit capability.
    expect(
      within(available).getByTestId("catalog-dashboard")
    ).toHaveTextContent("catalog isAdmin=false");
  });
});
