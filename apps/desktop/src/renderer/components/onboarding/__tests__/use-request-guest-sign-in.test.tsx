import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { signInFailureMessage } from "../../../shared-agent-sessions/desktop-sign-in-copy";
import type { DesktopBrowserSignInResult } from "../../../types/desktop-api";
import { useRequestGuestSignIn } from "../use-request-guest-sign-in";

const beginSignIn = vi.fn<() => Promise<DesktopBrowserSignInResult>>();
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: DesktopAuthStatus.SignedOut },
    beginSignIn,
  }),
}));

describe("guest sign-in outcomes", () => {
  beforeEach(() => beginSignIn.mockReset());

  it.each([
    { ok: true },
    { ok: false, reason: "cancelled" },
  ] satisfies DesktopBrowserSignInResult[])(
    "does not report success or cancellation as failure: %j",
    async (outcome) => {
      beginSignIn.mockResolvedValue(outcome);
      const client = createTestQueryClient();
      const onError = vi.fn();
      client.setDefaultOptions({ mutations: { onError, retry: false } });
      const { result } = renderHook(useRequestGuestSignIn, {
        wrapper: createWrapperWithClient(client),
      });
      act(() => result.current?.());
      await waitFor(() =>
        expect(client.getMutationCache().getAll()[0]?.state.status).toBe(
          "success"
        )
      );
      expect(beginSignIn).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    }
  );

  it("routes failed sign-in through the existing mutation error handler", async () => {
    beginSignIn.mockResolvedValue({ ok: false, reason: "open_failed" });
    const client = createTestQueryClient();
    const onError = vi.fn();
    client.setDefaultOptions({ mutations: { onError, retry: false } });
    const { result } = renderHook(useRequestGuestSignIn, {
      wrapper: createWrapperWithClient(client),
    });
    act(() => result.current?.());
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]?.[0]).toEqual(
      new Error(signInFailureMessage("open_failed"))
    );
  });
});
