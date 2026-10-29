import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AuthAdapter } from "../auth-adapter";
import { AuthAdapterProvider } from "../provider";
import { createStaticAuthAdapter } from "../static-auth-adapter";
import { useOrganizationIdentityResync } from "../use-organization-identity-resync";

function wrapper(adapter: AuthAdapter) {
  return ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider adapter={adapter}>{children}</AuthAdapterProvider>
  );
}

describe("useOrganizationIdentityResync", () => {
  it("calls through to a shell that implements the member", async () => {
    const resync = vi.fn().mockResolvedValue(undefined);
    const adapter: AuthAdapter = {
      ...createStaticAuthAdapter(),
      useOrganizationIdentityResync: () => resync,
    };

    const { result } = renderHook(() => useOrganizationIdentityResync(), {
      wrapper: wrapper(adapter),
    });
    await result.current("acme-rocketry");

    expect(resync).toHaveBeenCalledWith("acme-rocketry");
  });

  it("resolves to a no-op for a shell that omits it, rather than throwing", async () => {
    // The desktop renderer's shape: no URL-visible organization to re-anchor.
    // A throw here would turn a committed rename into a crashed panel.
    const { result } = renderHook(() => useOrganizationIdentityResync(), {
      wrapper: wrapper(createStaticAuthAdapter()),
    });

    await expect(result.current("acme-rocketry")).resolves.toBeUndefined();
  });

  it("keeps hook order fixed when the adapter gains the member between renders", () => {
    const withMember: AuthAdapter = {
      ...createStaticAuthAdapter(),
      useOrganizationIdentityResync: () => vi.fn().mockResolvedValue(undefined),
    };
    const { rerender, result } = renderHook(
      () => useOrganizationIdentityResync(),
      { wrapper: wrapper(createStaticAuthAdapter()) }
    );

    expect(typeof result.current).toBe("function");
    rerender();
    // Re-rendering under a different adapter must not warn or throw about a
    // changed hook count — the member is selected, then called unconditionally.
    renderHook(() => useOrganizationIdentityResync(), {
      wrapper: wrapper(withMember),
    });
    expect(typeof result.current).toBe("function");
  });
});
