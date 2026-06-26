import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../settings-page";

const mockSearchParams = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => mockSearchParams(),
}));

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@repo/auth/client", () => ({
  OrganizationProfile: () => null,
  OrganizationSwitcher: () => null,
  Show: ({ children }: { children: ReactNode }) => <>{children}</>,
  UserProfile: () => null,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

vi.mock(
  "@repo/app/custom-fields/components/custom-fields-settings-tab",
  () => ({
    CustomFieldsSettingsTab: () => null,
  })
);

vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: () => null,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
  useUpdateUser: () => ({ mutate: vi.fn() }),
}));

vi.mock("../anthropic-api-key-card", () => ({
  AnthropicApiKeyCard: () => null,
}));

vi.mock("../api-keys-settings-panel", () => ({
  ApiKeysSettingsPanel: () => null,
}));

vi.mock("../cloud-compute-mode-card", () => ({
  CloudComputeModeCard: () => null,
}));

vi.mock("../github-integration-card", () => ({
  GitHubIntegrationCard: () => null,
}));

vi.mock("../google-integration-card", () => ({
  GoogleIntegrationCard: () => null,
}));

vi.mock("../linear-integration-card", () => ({
  LinearIntegrationCard: () => null,
}));

vi.mock("../local-compute-targets-card", () => ({
  LocalComputeTargetsCard: () => null,
}));

vi.mock("../organization-slug-settings", () => ({
  OrganizationSlugSettings: () => null,
}));

describe("SettingsPage GitHub callback recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.mockReturnValue(new URLSearchParams());
  });

  it("invalidates GitHub queries when returning from GitHub connect", async () => {
    mockSearchParams.mockReturnValue(new URLSearchParams("github=connected"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage initialTab="integrations" isAdmin={false} />
      </QueryClientProvider>
    );

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: githubKeys.all,
      })
    );
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "GitHub connected successfully"
    );
  });

  it("preserves URL params and skips invalidation on requires_confirmation", async () => {
    mockSearchParams.mockReturnValue(
      new URLSearchParams(
        "github=requires_confirmation&priorAccountId=1&priorAccountLogin=old&newAccountId=2&newAccountLogin=new&newInstallationId=99"
      )
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const replaceStateSpy = vi.spyOn(globalThis.history, "replaceState");

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage initialTab="integrations" isAdmin={false} />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(replaceStateSpy).not.toHaveBeenCalled();
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    replaceStateSpy.mockRestore();
  });
});
