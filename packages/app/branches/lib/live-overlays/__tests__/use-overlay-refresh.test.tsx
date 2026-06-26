import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { branchesKeys } from "../../../hooks/use-branches";
import { branchesOverlayKeys } from "../overlay-keys";
import {
  BranchesOverlayRefreshProvider,
  type OverlayRefreshSignal,
} from "../overlay-refresh-provider";
import { useOverlayRefresh } from "../use-overlay-refresh";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function invalidatedKeys(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) =>
    JSON.stringify((call[0] as { queryKey?: unknown })?.queryKey)
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useOverlayRefresh", () => {
  it("refresh() invalidates the overlay namespace AND the persisted list/detail keys", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useOverlayRefresh(), {
      wrapper: wrapper(client),
    });

    act(() => result.current.refresh());

    const keys = invalidatedKeys(spy);
    expect(keys).toContain(JSON.stringify(branchesOverlayKeys.all()));
    expect(keys).toContain(JSON.stringify(branchesKeys.lists()));
    expect(keys).toContain(JSON.stringify(branchesKeys.details()));
  });

  it("reports isChecking false when no overlay query is in flight", () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useOverlayRefresh(), {
      wrapper: wrapper(client),
    });
    expect(result.current.isChecking).toBe(false);
  });
});

describe("BranchesOverlayRefreshProvider", () => {
  it("refreshes the overlays on a window focus event", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <BranchesOverlayRefreshProvider>
          <div />
        </BranchesOverlayRefreshProvider>
      </QueryClientProvider>
    );
    spy.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(invalidatedKeys(spy)).toContain(
        JSON.stringify(branchesOverlayKeys.all())
      )
    );
  });

  it("refreshes the overlays when the injected enrichment signal fires", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    let fire: (() => void) | null = null;
    const signal: OverlayRefreshSignal = {
      subscribe: (onSignal) => {
        fire = onSignal;
        return () => {
          fire = null;
        };
      },
    };
    render(
      <QueryClientProvider client={client}>
        <BranchesOverlayRefreshProvider signal={signal}>
          <div />
        </BranchesOverlayRefreshProvider>
      </QueryClientProvider>
    );
    spy.mockClear();
    expect(fire).not.toBeNull();

    act(() => {
      fire?.();
    });

    await waitFor(() =>
      expect(invalidatedKeys(spy)).toContain(
        JSON.stringify(branchesOverlayKeys.all())
      )
    );
  });
});
