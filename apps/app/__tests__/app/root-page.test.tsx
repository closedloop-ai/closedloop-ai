/**
 * ISS-10855 / PLN-2088 step 8: `/` renders nothing. A signed-out visit goes to
 * Clerk sign-up; a signed-in visit forwards to the canonical landing route
 * (Dashboard).
 */
import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { afterEach, describe, expect, it, vi } from "vitest";
import RootPage from "@/app/(landing)/page";

const authState = vi.hoisted(() => ({ userId: null as string | null }));

const redirectToSignUpMock = vi.hoisted(() =>
  vi.fn((_options?: { returnBackUrl?: string | null }): never => {
    throw new Error("NEXT_REDIRECT:sign-up");
  })
);

vi.mock("@repo/auth/server", () => ({
  auth: () =>
    Promise.resolve({
      redirectToSignUp: redirectToSignUpMock,
      userId: authState.userId,
    }),
}));

const redirectMock = vi.hoisted(() =>
  vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  })
);

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

afterEach(() => {
  authState.userId = null;
  redirectMock.mockClear();
  redirectToSignUpMock.mockClear();
});

describe("root page", () => {
  it("sends a signed-out visitor to sign-up and renders nothing", async () => {
    await expect(RootPage()).rejects.toThrow("NEXT_REDIRECT:sign-up");
    expect(redirectToSignUpMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("never hands `/` back as the post-sign-up destination", async () => {
    // ISS-11429. Clerk defaults `returnBackUrl` to the URL being served, so a
    // BARE `redirectToSignUp()` here produced
    // `/sign-up?redirect_url=https://app.closedloop.ai/` — and `/` is the one
    // destination guaranteed to re-enter this same redirect for a visitor the
    // server still reads as signed out. 16 of the measured looping prod views
    // carried exactly that `redirect_url`.
    //
    // Asserted as "an explicit destination that is not `/`", which is what makes
    // the case fail against a bare call: `toHaveBeenCalledWith()` on no argument
    // is what shipped, and it is the cycle.
    await expect(RootPage()).rejects.toThrow("NEXT_REDIRECT:sign-up");

    const [options] = redirectToSignUpMock.mock.calls[0] ?? [];
    expect(options?.returnBackUrl).toBe(WEB_CANONICAL_LANDING_HREF);
    expect(options?.returnBackUrl).not.toBe("/");
  });

  it("redirects a signed-in visitor to the canonical landing route", async () => {
    authState.userId = "user_123";

    // Asserted through the shared constant, not a literal: this entry point
    // hardcoded "/my-tasks" and so ignored the canonical landing route, which
    // is the defect. A literal here would let that come back green.
    await expect(RootPage()).rejects.toThrow(
      `NEXT_REDIRECT:${WEB_CANONICAL_LANDING_HREF}`
    );
    expect(redirectMock).toHaveBeenCalledWith(WEB_CANONICAL_LANDING_HREF);
    expect(redirectToSignUpMock).not.toHaveBeenCalled();
    expect(WEB_CANONICAL_LANDING_HREF).toBe("/dashboard");
  });
});
