import { DesktopBootstrapErrorCode } from "@repo/api/src/types/desktop-bootstrap";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findOrCreateUser: vi.fn(),
  mint: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("@repo/auth/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: mocks.findOrCreateUser,
}));
vi.mock("@/lib/observability/with-request-completed", () => ({
  withRequestCompleted: (handler: unknown) => handler,
}));
vi.mock("./service", () => ({
  desktopBootstrapAuthorizeService: { mint: mocks.mint },
}));
vi.mock("../authorize/service", () => ({
  desktopAuthorizeService: { mint: mocks.authorize },
}));

import { resolvePendingSessionPrincipal } from "@/lib/auth/pending-session-user";
import { POST as authorize } from "../authorize/route";
import { POST as bootstrap } from "./route";

describe("real browser principal boundaries", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    { userId: "user", orgId: "org", sessionStatus: "active" },
    { userId: "user", orgId: null, sessionStatus: "active" },
    { userId: "user", orgId: "org", sessionStatus: "pending" },
    { userId: null, orgId: null, sessionStatus: null },
  ])(
    "refuses bootstrap mint for an ineligible Clerk principal: %j",
    async (principal) => {
      mocks.auth.mockResolvedValue(principal);
      const response = await bootstrap(
        new Request("https://api.example/desktop/bootstrap-authorize", {
          method: "POST",
        })
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: DesktopBootstrapErrorCode.PendingSessionRequired,
      });
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.findOrCreateUser).not.toHaveBeenCalled();
    }
  );

  it("admits the pending orgless principal only to bootstrap, never ordinary authorization", async () => {
    mocks.auth.mockResolvedValue({
      userId: "pending-user",
      orgId: null,
      sessionStatus: "pending",
    });
    await expect(resolvePendingSessionPrincipal()).resolves.toEqual({
      clerkUserId: "pending-user",
    });
    expect(mocks.auth).toHaveBeenCalledWith({ treatPendingAsSignedOut: false });

    const response = await authorize(
      new Request("https://api.example/desktop/authorize", { method: "POST" })
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "SESSION_REQUIRED",
      retryable: false,
    });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.findOrCreateUser).not.toHaveBeenCalled();
  });
});
