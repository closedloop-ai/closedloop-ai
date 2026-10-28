import { type ApiKey, ApiKeyScope } from "@repo/api/src/types/api-key";
import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeysSettingsPanel } from "../api-keys-settings-panel";

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
};

const toastCalls: { kind: string; message: string }[] = [];

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_MCP_SERVER_URL: "https://mcp.example.test" },
}));

const ACTIVE_KEY: ApiKey = {
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  expiresAt: null,
  id: "key-1",
  keyPrefix: "sk_live_",
  lastUsedAt: null,
  name: "CI pipeline",
  organizationId: "org-1",
  revokedAt: null,
  scopes: [ApiKeyScope.Read, ApiKeyScope.Write, ApiKeyScope.Delete],
  userId: "user-1",
};

/**
 * The real mutation hooks under the PRODUCTION client factory, so the shared
 * default `mutations.onError` is live and a second toast would be counted
 * (ISS-11410). Each case also pins the failure that settles after the surface
 * unmounts, which the legacy Settings tabs do on a tab switch.
 */
function renderWithClient(ui: ReactNode) {
  return render(ui, {
    wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
  });
}

function pendingRequest() {
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

async function createKey() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Create Key" }));
  await user.type(screen.getByLabelText("Name"), "CI pipeline");
  await user.click(screen.getByRole("button", { name: "Create" }));
}

async function revokeKey() {
  const user = userEvent.setup();
  await screen.findByText("CI pipeline");
  await user.click(screen.getByRole("button", { name: "Revoke" }));
  await user.click(
    screen.getAllByRole("button", { name: "Revoke" }).at(-1) as HTMLElement
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  toastCalls.length = 0;
});

describe("legacy ApiKeysSettingsPanel failure toasts", () => {
  it("toasts a failed create exactly once", async () => {
    mockApiClient.get.mockResolvedValue([]);
    mockApiClient.post.mockRejectedValue(new ApiError("boom", 500));
    renderWithClient(<ApiKeysSettingsPanel />);

    await createKey();

    await waitFor(() =>
      expect(toastCalls).toEqual([
        { kind: "error", message: "Failed to create API key" },
      ])
    );
  });

  it("still toasts a failed create that settles after the panel unmounts", async () => {
    const request = pendingRequest();
    mockApiClient.get.mockResolvedValue([]);
    mockApiClient.post.mockReturnValue(request.promise);
    const view = renderWithClient(<ApiKeysSettingsPanel />);

    await createKey();
    await waitFor(() => expect(mockApiClient.post).toHaveBeenCalledTimes(1));
    view.unmount();
    request.reject(new ApiError("boom", 500));

    await waitFor(() =>
      expect(toastCalls).toEqual([
        { kind: "error", message: "Failed to create API key" },
      ])
    );
  });

  it("toasts a failed revoke exactly once", async () => {
    mockApiClient.get.mockResolvedValue([ACTIVE_KEY]);
    mockApiClient.delete.mockRejectedValue(new ApiError("boom", 500));
    renderWithClient(<ApiKeysSettingsPanel />);

    await revokeKey();

    await waitFor(() =>
      expect(toastCalls).toEqual([
        { kind: "error", message: "Failed to revoke API key" },
      ])
    );
  });

  it("still toasts a failed revoke that settles after the panel unmounts", async () => {
    const request = pendingRequest();
    mockApiClient.get.mockResolvedValue([ACTIVE_KEY]);
    mockApiClient.delete.mockReturnValue(request.promise);
    const view = renderWithClient(<ApiKeysSettingsPanel />);

    await revokeKey();
    await waitFor(() => expect(mockApiClient.delete).toHaveBeenCalledTimes(1));
    view.unmount();
    request.reject(new ApiError("boom", 500));

    await waitFor(() =>
      expect(toastCalls).toEqual([
        { kind: "error", message: "Failed to revoke API key" },
      ])
    );
  });
});
