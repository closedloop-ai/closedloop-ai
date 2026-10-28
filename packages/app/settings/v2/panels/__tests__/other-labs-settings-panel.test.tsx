import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../shared/api/api-error";
import { makeQueryClient } from "../../../../shared/query/query-client";
import { ORG_POLICY_SAVE_FAILED_MESSAGE } from "../../../lib/org-policy-toggle-state";
import { OtherLabsSettingsPanel } from "../other-labs-settings-panel";

const mockApiClient = {
  get: vi.fn(),
  put: vi.fn(),
};

const toastCalls: { kind: string; message: string }[] = [];

vi.mock("../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ kind: "error", message }),
    success: (message: string) => toastCalls.push({ kind: "success", message }),
  },
}));

const TOGGLE_LABEL = "Score sessions for frustration";
const ADMIN_REQUIRED_TEXT =
  "That change needs an organization admin. Your setting is unchanged.";

/**
 * The PRODUCTION client factory, not a bare `QueryClient` (#6392, tamsinb).
 * `makeQueryClient` installs the default `mutations.onError` that toasts every
 * rejected mutation; a bare client omits it, so this file could not see the
 * generic toast that used to land on top of each inline save outcome below.
 */
function renderPanel() {
  const queryClient = makeQueryClient({ gcTime: 0 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<OtherLabsSettingsPanel />, { wrapper });
}

function panelState(): string | null {
  const node = document.querySelector("[data-settings-panel-data-state]");
  return node?.getAttribute("data-settings-panel-data-state") ?? null;
}

describe("OtherLabsSettingsPanel read states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders no switch at all until the setting has actually been read", async () => {
    // AC3: a Labs control must stay default-off. An unread value must never be
    // painted as a position, in EITHER direction — a switch showing "off" for a
    // setting that is really on is the same lie as the reverse.
    let resolveRead: ((value: unknown) => void) | undefined;
    mockApiClient.get.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      })
    );

    renderPanel();

    await waitFor(() => expect(panelState()).toBe("loading"));
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    resolveRead?.({ calculateSessionFrustration: true });
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
  });

  it("renders a failed read as failed with no switch, never as an off toggle", async () => {
    mockApiClient.get.mockRejectedValue(new ApiError("boom", 500));

    renderPanel();

    await waitFor(() => expect(panelState()).toBe("failed"));
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("renders a refusal and an unresolved role as DIFFERENT states", async () => {
    mockApiClient.get.mockRejectedValue(new ApiError("denied", 403));
    const denied = renderPanel();
    await waitFor(() => expect(panelState()).toBe("forbidden"));
    denied.unmount();

    mockApiClient.get.mockRejectedValue(new ApiError("role unresolved", 503));
    renderPanel();
    await waitFor(() => expect(panelState()).toBe("unavailable"));
  });

  it("shows the switch in the position the server reported", async () => {
    mockApiClient.get.mockResolvedValue({ calculateSessionFrustration: false });

    renderPanel();

    const toggle = await screen.findByRole("switch");
    expect(toggle).not.toBeChecked();
    expect(panelState()).toBeNull();
  });
});

describe("OtherLabsSettingsPanel save outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastCalls.length = 0;
  });

  it("says a refused save needs an admin, not that it should be retried", async () => {
    // The write is admin-gated by the route. Hiding the switch is NOT the
    // boundary — the server refuses — so the panel must report the refusal
    // honestly instead of the generic "Try again", which cannot work.
    const user = userEvent.setup();
    mockApiClient.get.mockResolvedValue({ calculateSessionFrustration: false });
    mockApiClient.put.mockRejectedValue(new ApiError("denied", 403));

    renderPanel();
    await user.click(await screen.findByLabelText(TOGGLE_LABEL));

    expect(await screen.findByText(ADMIN_REQUIRED_TEXT)).toBeInTheDocument();
    expect(
      screen.queryByText(ORG_POLICY_SAVE_FAILED_MESSAGE)
    ).not.toBeInTheDocument();
    // And ONLY that sentence. The shared client's default mutation handler used
    // to add a generic "Operation failed" toast beside this alert, so a member
    // was told both that the change went wrong and that it needs an admin.
    expect(toastCalls).toEqual([]);
  });

  it("says an unresolved save decided nothing about access", async () => {
    const user = userEvent.setup();
    mockApiClient.get.mockResolvedValue({ calculateSessionFrustration: false });
    mockApiClient.put.mockRejectedValue(new ApiError("role unresolved", 503));

    renderPanel();
    await user.click(await screen.findByLabelText(TOGGLE_LABEL));

    expect(
      await screen.findByText(
        "We couldn't reach the service, so nothing was changed and nothing about your access was decided. Try again shortly."
      )
    ).toBeInTheDocument();
  });

  it("falls back to the card's generic save error for anything else", async () => {
    const user = userEvent.setup();
    mockApiClient.get.mockResolvedValue({ calculateSessionFrustration: false });
    mockApiClient.put.mockRejectedValue(new ApiError("boom", 500));

    renderPanel();
    await user.click(await screen.findByLabelText(TOGGLE_LABEL));

    expect(
      await screen.findByText(ORG_POLICY_SAVE_FAILED_MESSAGE)
    ).toBeInTheDocument();
    expect(screen.queryByText(ADMIN_REQUIRED_TEXT)).not.toBeInTheDocument();
  });
});
