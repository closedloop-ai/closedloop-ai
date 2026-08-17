import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLocalAgentSessionUsage } from "../use-local-agent-session-usage";

let desktopApiDescriptor: PropertyDescriptor | undefined;

function stubDesktopApi(
  usage: (() => Promise<AgentSessionUsageSummary>) | undefined
) {
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: usage ? { agentSessionsApi: { usage } } : {},
  });
}

function restoreDesktopApi() {
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  desktopApiDescriptor = undefined;
}

function wrapper() {
  // No retries so a rejected read settles to `isError` immediately.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const LOCAL_TOTALS = {
  totalSessions: 42,
  totalInputTokens: 10,
  totalOutputTokens: 5,
} as unknown as AgentSessionUsageSummary;

describe("useLocalAgentSessionUsage (FEA-3574 — SQLite-backed always-available cards)", () => {
  afterEach(() => {
    restoreDesktopApi();
    vi.restoreAllMocks();
  });

  it("reads local totals over IPC when enabled", async () => {
    const usage = vi.fn().mockResolvedValue(LOCAL_TOTALS);
    stubDesktopApi(usage);

    const { result } = renderHook(
      () => useLocalAgentSessionUsage({ search: "x" }, { enabled: true }),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.data).toEqual(LOCAL_TOTALS));
    expect(usage).toHaveBeenCalledWith({ search: "x" });
  });

  it("does not read when disabled (never fires the local IPC)", () => {
    const usage = vi.fn().mockResolvedValue(LOCAL_TOTALS);
    stubDesktopApi(usage);

    renderHook(() => useLocalAgentSessionUsage({}, { enabled: false }), {
      wrapper: wrapper(),
    });

    expect(usage).not.toHaveBeenCalled();
  });

  it("settles to isError when the local usage API is unavailable", async () => {
    stubDesktopApi(undefined);

    const { result } = renderHook(
      () => useLocalAgentSessionUsage({}, { enabled: true }),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
