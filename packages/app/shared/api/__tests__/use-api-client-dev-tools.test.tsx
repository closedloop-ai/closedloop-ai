import {
  FEATURE_FLAG_OVERRIDES_HEADER,
  FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
  FEATURE_FLAGS_CHECKED_HEADER,
} from "@repo/api/src/types/feature-flag-overrides";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import {
  readCheckedFeatureFlags,
  resetCheckedFeatureFlags,
} from "../../dev-tools/lib/checked-feature-flags-store";
import { DEV_MODE_STORAGE_KEY } from "../../feature-flags/dev-mode/dev-mode-contract";
import {
  DevModeEligibility,
  DevModeProvider,
} from "../../feature-flags/dev-mode/dev-mode-provider";
import { ApiAdapterProvider } from "../provider";
import { useApiClient } from "../use-api-client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const GRANT_FLAG = "session-trace-tab";
const RESTRICTION_FLAG = "compute-target-signing";

afterEach(() => {
  fetchMock.mockReset();
  localStorage.removeItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY);
  localStorage.removeItem(DEV_MODE_STORAGE_KEY);
  resetCheckedFeatureFlags();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function wrapper(eligibility: DevModeEligibility) {
  return ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
      <ApiAdapterProvider
        adapter={{ resolveApiOrigin: () => "https://api.test" }}
      >
        <DevModeProvider eligibility={eligibility} isRolledOut>
          {children}
        </DevModeProvider>
      </ApiAdapterProvider>
    </AuthAdapterProvider>
  );
}

function respondWithChecked(checked: string | null) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ success: true, data: null }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...(checked === null
          ? {}
          : { [FEATURE_FLAGS_CHECKED_HEADER]: checked }),
      },
    })
  );
}

function sentHeaders(): Headers {
  const [, init] = fetchMock.mock.calls.at(-1) ?? [];
  return new Headers((init as RequestInit).headers);
}

/**
 * ISS-12048. The browser half of the server-side overrides: the shared API
 * client sends the stored overrides only while Dev Mode is on, never a
 * restriction key, and records the flags the API says it checked.
 */
describe("useApiClient under Dev Mode", () => {
  it("sends the stored overrides, minus restriction keys, and records the checked flags", async () => {
    localStorage.setItem(
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ [GRANT_FLAG]: true, [RESTRICTION_FLAG]: false })
    );
    respondWithChecked(`${GRANT_FLAG},pensero-integration`);
    const { result } = renderHook(() => useApiClient(), {
      wrapper: wrapper(DevModeEligibility.Eligible),
    });

    await result.current.get("/things");

    expect(
      JSON.parse(sentHeaders().get(FEATURE_FLAG_OVERRIDES_HEADER) ?? "null")
    ).toEqual({ [GRANT_FLAG]: true });
    expect([...readCheckedFeatureFlags()]).toEqual([
      GRANT_FLAG,
      "pensero-integration",
    ]);
  });

  it("sends nothing while Dev Mode is off", async () => {
    localStorage.setItem(
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ [GRANT_FLAG]: true })
    );
    respondWithChecked(GRANT_FLAG);
    const { result } = renderHook(() => useApiClient(), {
      wrapper: wrapper(DevModeEligibility.Ineligible),
    });

    await result.current.get("/things");

    expect(sentHeaders().has(FEATURE_FLAG_OVERRIDES_HEADER)).toBe(false);
    expect(readCheckedFeatureFlags().size).toBe(0);
  });
});
