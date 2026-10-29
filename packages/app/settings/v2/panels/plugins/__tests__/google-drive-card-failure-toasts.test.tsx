import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../shared/api/api-error";
import { makeQueryClient } from "../../../../../shared/query/query-client";
import { createWrapperWithClient } from "../../../../../shared/test-utils";
import { GoogleDriveCard } from "../google-drive-card";

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
};

const toastCalls: { kind: string; message: string }[] = [];

vi.mock("../../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("../../../../../google/components/google-import-modal", () => ({
  GoogleImportModal: () => null,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

const CONNECTED = { connected: true, email: "drive@example.test" };
const DISCONNECT_FAILURE_TOAST = {
  kind: "error",
  message: "Failed to disconnect Google Drive",
};

/**
 * The real `useDisconnectGoogle` under the PRODUCTION client factory, so the
 * shared default `mutations.onError` is live and a second toast would be
 * counted (ISS-11410).
 */
function renderCard() {
  return render(<GoogleDriveCard />, {
    wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
  });
}

async function confirmDisconnect() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Disconnect" }));
  await user.click(
    screen.getAllByRole("button", { name: "Disconnect" }).at(-1) as HTMLElement
  );
}

describe("GoogleDriveCard disconnect failure toasts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastCalls.length = 0;
    mockApiClient.get.mockResolvedValue(CONNECTED);
  });

  it("toasts a failed disconnect exactly once", async () => {
    mockApiClient.delete.mockRejectedValue(new ApiError("boom", 500));
    renderCard();

    await confirmDisconnect();

    await waitFor(() => expect(toastCalls).toEqual([DISCONNECT_FAILURE_TOAST]));
  });

  it("still toasts a failed disconnect that settles after the card unmounts", async () => {
    let rejectDisconnect: (reason: unknown) => void = () => undefined;
    mockApiClient.delete.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectDisconnect = reject;
      })
    );
    const view = renderCard();

    await confirmDisconnect();
    await waitFor(() => expect(mockApiClient.delete).toHaveBeenCalledTimes(1));
    view.unmount();
    rejectDisconnect(new ApiError("boom", 500));

    await waitFor(() => expect(toastCalls).toEqual([DISCONNECT_FAILURE_TOAST]));
  });
});
