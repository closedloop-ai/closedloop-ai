import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { GITHUB_CLERK_RELINK_ATTEMPTED_PARAM } from "@repo/api/src/types/github-clerk-link";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const syncClerkLinkedIdentityMock = vi.fn();
const runPostConnectObservedSyncMock = vi.fn();
const waitUntilMock = vi.fn();

const AUTH_ORGANIZATION_ID = "org-1";
const AUTH_USER_ID = "user-1";

vi.mock("@vercel/functions", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (
      handler: (
        context: { user: { id: string; organizationId: string } },
        request: Request
      ) => Promise<Response>
    ) =>
    (request: Request) =>
      handler(
        { user: { id: AUTH_USER_ID, organizationId: AUTH_ORGANIZATION_ID } },
        request
      ),
}));

vi.mock("@/app/integrations/github/clerk-link-service", () => ({
  syncClerkLinkedIdentity: syncClerkLinkedIdentityMock,
}));

vi.mock("@/app/integrations/github/post-connect-sync-service", () => ({
  runPostConnectObservedSync: runPostConnectObservedSyncMock,
}));

const { POST } = await import("./route");

function request(search = "") {
  return new NextRequest(
    `http://localhost/integrations/github/clerk-link${search}`,
    { method: "POST" }
  );
}

const EMPTY_CONTEXT = { params: Promise.resolve({}) };

/** A promise only the sync returns, so the handoff can be pinned by identity. */
const SYNC_RESULT = Promise.resolve(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  runPostConnectObservedSyncMock.mockReturnValue(SYNC_RESULT);
});

describe("POST /integrations/github/clerk-link", () => {
  it("starts the post-connect sync for the caller's org once the link is usable", async () => {
    syncClerkLinkedIdentityMock.mockResolvedValue({ linked: true });

    const response = await POST(request(), EMPTY_CONTEXT);

    expect(response.status).toBe(200);
    expect(runPostConnectObservedSyncMock).toHaveBeenCalledWith({
      organizationId: AUTH_ORGANIZATION_ID,
    });
    // Handed to `waitUntil`, not awaited: the linking page's response must not
    // wait on a sweep, and a bare floating promise would be killed with the
    // function. Pinned by IDENTITY — asserting the two calls separately stays
    // green against a route that starts the sync and hands `waitUntil` something
    // else, which is the fire-and-forget defect this is here to catch.
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    // `toHaveBeenCalledWith` compares STRUCTURALLY, and two distinct promises
    // with no own enumerable properties are structurally equal — it stays green
    // against `waitUntil(Promise.resolve())`. Identity is the assertion.
    expect(waitUntilMock.mock.calls[0]?.[0]).toBe(SYNC_RESULT);
  });

  /**
   * ISS-10459: the marker is the only thing separating a terminal
   * `insufficient_scope` from the benign one the linking page answers by
   * re-linking, and this route is where it crosses from the URL into the
   * service. Asserted on the SERVICE ARGUMENT, not on the response, because
   * the verdict the caller sees is identical either way.
   */
  it("hands the service the re-link marker the caller carried", async () => {
    syncClerkLinkedIdentityMock.mockResolvedValue({ linked: true });

    await POST(
      request(`?${GITHUB_CLERK_RELINK_ATTEMPTED_PARAM}=1`),
      EMPTY_CONTEXT
    );

    expect(syncClerkLinkedIdentityMock).toHaveBeenCalledWith({
      organizationId: AUTH_ORGANIZATION_ID,
      userId: AUTH_USER_ID,
      relinkAttempted: true,
    });
  });

  it("reads a caller that carried no marker as not yet through consent", async () => {
    syncClerkLinkedIdentityMock.mockResolvedValue({ linked: true });

    await POST(request(), EMPTY_CONTEXT);

    expect(syncClerkLinkedIdentityMock).toHaveBeenCalledWith({
      organizationId: AUTH_ORGANIZATION_ID,
      userId: AUTH_USER_ID,
      relinkAttempted: false,
    });
  });

  it("starts nothing when the link yields no usable credential", async () => {
    syncClerkLinkedIdentityMock.mockResolvedValue({
      linked: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });

    const response = await POST(request(), EMPTY_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { linked: false },
    });
    expect(runPostConnectObservedSyncMock).not.toHaveBeenCalled();
    expect(waitUntilMock).not.toHaveBeenCalled();
  });
});
