import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../shared/api/api-error";
import { makeQueryClient } from "../../../../../shared/query/query-client";
import { buildComplianceGapFixture } from "../../../test-fixtures/governance-panel-fixtures";
import { CompliancePanel } from "../compliance-panel";

const mockApiClient = { get: vi.fn() };

vi.mock("../../../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const SERVER_ERROR_TEXT_RE = /relation agent_component does not exist/;

const GAP = buildComplianceGapFixture();

function renderPanel() {
  const queryClient = makeQueryClient({ gcTime: 0 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<CompliancePanel />, { wrapper });
}

function panelState(): string | null {
  const node = document.querySelector("[data-settings-panel-data-state]");
  return node?.getAttribute("data-settings-panel-data-state") ?? null;
}

describe("CompliancePanel read states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds a still-running read as loading, not as a completed empty result", async () => {
    // The whole promise of this panel. Without a held case, dropping or
    // miswiring `isPending` would leave every other case in this file green.
    let resolveRead: ((value: unknown) => void) | undefined;
    mockApiClient.get.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      })
    );

    renderPanel();

    await waitFor(() => expect(panelState()).toBe("loading"));
    expect(screen.queryByText("No compliance gaps")).not.toBeInTheDocument();
    expect(screen.queryByText("Repo Guardrails")).not.toBeInTheDocument();

    resolveRead?.({ items: [GAP], total: 1 });
    expect(await screen.findByText("Repo Guardrails")).toBeInTheDocument();
  });

  it("renders the measured grid once the read lands", async () => {
    mockApiClient.get.mockResolvedValue({ items: [GAP], total: 1 });

    renderPanel();

    expect(await screen.findByText("Repo Guardrails")).toBeInTheDocument();
    expect(panelState()).toBeNull();
  });

  it("keeps a refusal and an undecided read apart, and shows neither as empty", async () => {
    // Compliance is the ONE gated read in the policy table, so 403 is an
    // expected member outcome here rather than an exotic one. The legacy tab
    // renders 403 and 500 identically.
    mockApiClient.get.mockRejectedValue(new ApiError("denied", 403));
    const denied = renderPanel();
    await waitFor(() => expect(panelState()).toBe("forbidden"));
    expect(screen.queryByText("No compliance gaps")).not.toBeInTheDocument();
    denied.unmount();

    mockApiClient.get.mockRejectedValue(new ApiError("role unresolved", 503));
    renderPanel();
    await waitFor(() => expect(panelState()).toBe("unavailable"));
  });

  it("never renders the server's own error text", async () => {
    // The legacy tab prints `error.message` straight into the UI. Server text is
    // not user copy and can carry internal detail.
    mockApiClient.get.mockRejectedValue(
      new ApiError("pg: relation agent_component does not exist", 500)
    );

    renderPanel();

    await waitFor(() => expect(panelState()).toBe("failed"));
    expect(screen.queryByText(SERVER_ERROR_TEXT_RE)).not.toBeInTheDocument();
  });

  it("reports a genuinely gap-free organization as empty, not as a failure", async () => {
    mockApiClient.get.mockResolvedValue({ items: [], total: 0 });

    renderPanel();

    await waitFor(() => expect(panelState()).toBe("empty"));
    expect(screen.getByText("No compliance gaps")).toBeInTheDocument();
  });
});
