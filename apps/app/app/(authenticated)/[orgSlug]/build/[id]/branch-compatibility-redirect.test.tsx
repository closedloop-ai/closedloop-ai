import { BranchCompatibilityOutcome } from "@repo/api/src/types/branch-compatibility";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.get }),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagGate: () => ({ enabled: true, isReady: true }),
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: () => ({ enabled: true, isReady: true }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace: mocks.replace }),
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams("github=connected"),
}));

import {
  BranchCompatibilityRedirect,
  LegacyBranchRedirectKind,
  resolveBranchCompatibilityRedirect,
} from "./branch-compatibility-redirect";

const branchArtifactId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

it("wires the compatibility API result into canonical navigation", async () => {
  mocks.get.mockResolvedValue({
    branchArtifactId,
    outcome: BranchCompatibilityOutcome.Eligible,
  });
  const queryClient = createTestQueryClient();

  render(
    <QueryClientProvider client={queryClient}>
      <BranchCompatibilityRedirect
        branchArtifactId={branchArtifactId}
        orgSlug="acme"
      />
    </QueryClientProvider>
  );

  await waitFor(() => {
    expect(mocks.get).toHaveBeenCalledWith(
      `/branches/${branchArtifactId}/compatibility`
    );
    expect(mocks.replace).toHaveBeenCalledWith(
      `/acme/branches/${branchArtifactId}?github=connected`
    );
  });
});

it("renders the bounded unavailable state after the compatibility request fails", async () => {
  mocks.get.mockRejectedValue(new Error("compatibility unavailable"));
  const queryClient = createTestQueryClient();

  render(
    <QueryClientProvider client={queryClient}>
      <BranchCompatibilityRedirect
        branchArtifactId={branchArtifactId}
        orgSlug="acme"
      />
    </QueryClientProvider>
  );

  expect(await screen.findByText("Branch not found")).toBeVisible();
  expect(mocks.replace).not.toHaveBeenCalled();
});

describe("resolveBranchCompatibilityRedirect", () => {
  it("preserves an already-issued OAuth query on the canonical redirect", () => {
    expect(
      resolveBranchCompatibilityRedirect({
        resolution: {
          branchArtifactId,
          outcome: BranchCompatibilityOutcome.Eligible,
          providerUrl: "https://github.com/acme/repo/pull/42",
        },
        rolloutEnabled: true,
        rolloutReady: true,
        orgSlug: "acme",
        search: "github=connected",
      })
    ).toEqual({
      kind: LegacyBranchRedirectKind.Internal,
      href: `/acme/branches/${branchArtifactId}?github=connected`,
    });
  });

  it("uses only a server-approved provider fallback while rollout is off", () => {
    expect(
      resolveBranchCompatibilityRedirect({
        resolution: {
          branchArtifactId,
          outcome: BranchCompatibilityOutcome.Eligible,
          providerUrl: "https://github.com/acme/repo/pull/42",
        },
        rolloutEnabled: false,
        rolloutReady: true,
        orgSlug: "acme",
        search: "",
      })
    ).toEqual({
      kind: LegacyBranchRedirectKind.External,
      href: "https://github.com/acme/repo/pull/42",
    });
  });

  it.each([
    {
      label: "unavailable",
      resolution: { outcome: BranchCompatibilityOutcome.Unavailable },
    },
    {
      label: "eligible without a provider fallback while rollout is off",
      resolution: {
        branchArtifactId,
        outcome: BranchCompatibilityOutcome.Eligible,
      },
    },
  ])("fails closed for $label", ({ resolution }) => {
    expect(
      resolveBranchCompatibilityRedirect({
        resolution,
        rolloutEnabled: false,
        rolloutReady: true,
        orgSlug: "acme",
        search: "",
      })
    ).toEqual({ kind: LegacyBranchRedirectKind.Unavailable });
  });

  it("settles a failed request as unavailable instead of pending", () => {
    expect(
      resolveBranchCompatibilityRedirect({
        requestFailed: true,
        rolloutEnabled: true,
        rolloutReady: true,
        orgSlug: "acme",
        search: "",
      })
    ).toEqual({ kind: LegacyBranchRedirectKind.Unavailable });
  });
});
