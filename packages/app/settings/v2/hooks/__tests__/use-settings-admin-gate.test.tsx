import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanelDataState } from "../../lib/settings-panel-data-state";
import { useSettingsAdminGate } from "../use-settings-admin-gate";

const mockApiClient = { get: vi.fn() };

vi.mock("../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function viewModelFor(role: SettingsActorRole) {
  return projectSettingsViewModel({
    resolution: { role, status: SettingsActorRoleStatus.Resolved },
    staleSessionRole: false,
  });
}

function renderGate() {
  return renderHook(() => useSettingsAdminGate(SettingsDomainId.ApiKeys), {
    wrapper: wrapper(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSettingsAdminGate", () => {
  it("is Loading, and not admin, while the view model is in flight", () => {
    mockApiClient.get.mockReturnValue(new Promise(() => undefined));

    const { result } = renderGate();

    expect(result.current.accessState).toBe(SettingsPanelDataState.Loading);
    expect(result.current.isAdmin).toBe(false);
  });

  it("is Failed, and not admin, when the view model read fails", async () => {
    mockApiClient.get.mockRejectedValue(new Error("boom"));

    const { result } = renderGate();

    await waitFor(() =>
      expect(result.current.accessState).toBe(SettingsPanelDataState.Failed)
    );
    expect(result.current.isAdmin).toBe(false);
  });

  it.each([
    { isAdmin: true, role: SettingsActorRole.Admin },
    { isAdmin: false, role: SettingsActorRole.Member },
  ])(
    "is Ready with isAdmin $isAdmin for a settled $role",
    async ({ isAdmin, role }) => {
      mockApiClient.get.mockResolvedValue(viewModelFor(role));

      const { result } = renderGate();

      await waitFor(() =>
        expect(result.current.accessState).toBe(SettingsPanelDataState.Ready)
      );
      expect(result.current.isAdmin).toBe(isAdmin);
    }
  );
});
