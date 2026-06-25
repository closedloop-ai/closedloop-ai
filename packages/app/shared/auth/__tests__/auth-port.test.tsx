import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AuthAdapterProvider } from "../provider";
import { createStaticAuthAdapter } from "../static-auth-adapter";
import { useAuthSnapshot } from "../use-auth-snapshot";
import { useWaitForAuthLoaded } from "../use-wait-for-auth-loaded";

const AUTH_PROVIDER_ERROR = /AuthAdapterProvider/;

describe("auth port", () => {
  it("exposes the adapter snapshot through useAuthSnapshot", async () => {
    const adapter = createStaticAuthAdapter({
      userId: "user_42",
      orgId: "org_42",
      getToken: () => Promise.resolve("tok"),
    });
    const { result } = renderHook(() => useAuthSnapshot(), {
      wrapper: createWrapper(adapter),
    });

    expect(result.current).toMatchObject({
      isLoaded: true,
      userId: "user_42",
      orgId: "org_42",
    });
    await expect(result.current.getToken()).resolves.toBe("tok");
  });

  it("throws a descriptive error outside an AuthAdapterProvider", () => {
    expect(() => renderHook(() => useAuthSnapshot())).toThrow(
      AUTH_PROVIDER_ERROR
    );
  });

  it("resolves waitForAuthLoaded immediately when already loaded", async () => {
    const { result } = renderHook(() => useWaitForAuthLoaded(), {
      wrapper: createWrapper(createStaticAuthAdapter()),
    });

    await expect(result.current()).resolves.toBeUndefined();
  });
});

function createWrapper(adapter: ReturnType<typeof createStaticAuthAdapter>) {
  return ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider adapter={adapter}>{children}</AuthAdapterProvider>
  );
}
