import {
  SettingsDomainFailureReason,
  SettingsDomainId,
  SettingsDomainStatus,
} from "@repo/api/src/types/settings-domain";
import { SettingsActorCapabilityStatus } from "@repo/api/src/types/settings-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApiClient = { get: vi.fn() };

vi.mock("../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

import {
  settingsViewModelKeys,
  useSettingsDomainAccess,
  useSettingsShellCapabilities,
  useSettingsViewModel,
} from "../use-settings-view-model";

const READY_GRANTS = { admin: true, edit: true, owner: false, read: true };

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function viewModelWith(
  access: Record<string, unknown>
): Record<string, unknown> {
  return {
    domains: { [SettingsDomainId.Organization]: access },
    status: "ready",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSettingsViewModel", () => {
  it("reads the ISS-8378 aggregate under one shared key so panels do not each pay a membership round-trip", async () => {
    mockApiClient.get.mockResolvedValue(
      viewModelWith({
        grants: READY_GRANTS,
        status: SettingsDomainStatus.Ready,
      })
    );

    const { result } = renderHook(() => useSettingsViewModel(), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith("/settings/view-model");
    expect(settingsViewModelKeys.viewModel()).toEqual([
      "settings",
      "view-model",
    ]);
  });
});

describe("useSettingsDomainAccess", () => {
  it("reports pending while the aggregate is in flight", () => {
    mockApiClient.get.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(
      () => useSettingsDomainAccess(SettingsDomainId.Organization),
      { wrapper: wrapper() }
    );

    expect(result.current.status).toBe("pending");
  });

  it("reports error — carrying NO grants — when the aggregate request fails", async () => {
    mockApiClient.get.mockRejectedValue(new Error("503"));

    const { result } = renderHook(
      () => useSettingsDomainAccess(SettingsDomainId.Organization),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    // The arm carries no `grants` key at all, so a caller cannot read a denial
    // out of a read that never answered.
    expect(result.current).toEqual({ status: "error" });
  });

  it("reports error when the aggregate succeeded but THIS domain could not be decided", async () => {
    mockApiClient.get.mockResolvedValue(
      viewModelWith({
        grants: { admin: false, edit: false, owner: false, read: false },
        reason: SettingsDomainFailureReason.UpstreamUnavailable,
        status: SettingsDomainStatus.Error,
      })
    );

    const { result } = renderHook(
      () => useSettingsDomainAccess(SettingsDomainId.Organization),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("passes settled grants through, including a forbidden answer, which IS an answer", async () => {
    const forbiddenGrants = {
      admin: false,
      edit: false,
      owner: false,
      read: false,
    };
    mockApiClient.get.mockResolvedValue(
      viewModelWith({
        grants: forbiddenGrants,
        status: SettingsDomainStatus.Forbidden,
      })
    );

    const { result } = renderHook(
      () => useSettingsDomainAccess(SettingsDomainId.Organization),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.status).toBe("settled"));
    expect(result.current).toEqual({
      grants: forbiddenGrants,
      status: "settled",
    });
  });

  it("passes a ready admin projection through", async () => {
    mockApiClient.get.mockResolvedValue(
      viewModelWith({
        grants: READY_GRANTS,
        status: SettingsDomainStatus.Ready,
      })
    );

    const { result } = renderHook(
      () => useSettingsDomainAccess(SettingsDomainId.Organization),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.status).toBe("settled"));
    expect(result.current).toEqual({ grants: READY_GRANTS, status: "settled" });
  });
});

/**
 * ISS-8370 M1 — the shell's projection of the same read. Pending and failed
 * reads reach the shell as their own capability statuses, never as a grant or
 * a denial, and the retry re-issues the request.
 */
describe("useSettingsShellCapabilities", () => {
  it("reports pending while the aggregate is in flight", () => {
    mockApiClient.get.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useSettingsShellCapabilities(), {
      wrapper: wrapper(),
    });

    expect(result.current.capabilities).toEqual({
      status: SettingsActorCapabilityStatus.Pending,
    });
  });

  it("reports a failed read as a capability error, carrying no grants", async () => {
    mockApiClient.get.mockRejectedValue(new Error("503"));

    const { result } = renderHook(() => useSettingsShellCapabilities(), {
      wrapper: wrapper(),
    });

    await waitFor(() =>
      expect(result.current.capabilities.status).toBe(
        SettingsActorCapabilityStatus.Error
      )
    );
    expect(result.current.capabilities).not.toHaveProperty("grants");
  });

  it("hands the shell the server's capability projection once it settles, and retries on demand", async () => {
    const capabilities = {
      grants: { profile: ["read"] },
      status: SettingsActorCapabilityStatus.Ready,
    };
    mockApiClient.get.mockResolvedValue({
      ...viewModelWith({
        grants: READY_GRANTS,
        status: SettingsDomainStatus.Ready,
      }),
      capabilities,
    });

    const { result } = renderHook(() => useSettingsShellCapabilities(), {
      wrapper: wrapper(),
    });

    await waitFor(() =>
      expect(result.current.capabilities).toEqual(capabilities)
    );
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalledTimes(2));
  });
});
