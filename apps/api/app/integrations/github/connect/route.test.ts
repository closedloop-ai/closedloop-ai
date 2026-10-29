import { GitHubBackfillStatus } from "@repo/api/src/types/github";
import { GitHubConnectErrorCode } from "@repo/api/src/types/github-clerk-link";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const claimGitHubInstallationMock = vi.fn();
const findByClerkIdMock = vi.fn();
const runPostConnectBackfillMock = vi.fn();
const startPostConnectBackfillMock = vi.fn();
const waitUntilMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("@vercel/functions", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: logErrorMock,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findByClerkId: findByClerkIdMock,
  },
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (
      handler: (
        context: {
          clerkOrgId: string;
          user: { id: string; organizationId: string };
        },
        request: Request
      ) => Promise<Response>
    ) =>
    (request: Request) =>
      handler(
        {
          clerkOrgId: "clerk-org-1",
          user: { id: "user-1", organizationId: "org-1" },
        },
        request
      ),
}));

vi.mock("../backfill-service", () => ({
  githubBackfillService: {
    runPostConnectBackfill: runPostConnectBackfillMock,
    startPostConnectBackfill: startPostConnectBackfillMock,
  },
}));

vi.mock("../service", () => ({
  githubService: {
    claimGitHubInstallation: claimGitHubInstallationMock,
  },
}));

const { POST } = await import("./route");

const EMPTY_CONTEXT = { params: Promise.resolve({}) };
/**
 * The real sweep measured 90s-180s. A case that stands in a never-resolving
 * one asserts the response does not depend on it, so it needs its own short
 * deadline rather than the runner default.
 */
const NON_BLOCKING_ASSERTION_TIMEOUT_MS = 1000;

describe("POST /integrations/github/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByClerkIdMock.mockResolvedValue({ id: "org-1" });
    claimGitHubInstallationMock.mockResolvedValue({ status: "connected" });
    runPostConnectBackfillMock.mockResolvedValue({
      status: GitHubBackfillStatus.OwnerApprovalRequired,
      repositoryCount: 1,
      branchCount: 0,
      pullRequestCount: 0,
      branchProjectionChangeCount: 0,
      pullRequestProjectionChangeCount: 0,
      reviewDecisionProjectionChangeCount: 0,
      checkProjectionChangeCount: 0,
      issueCommentProjectionChangeCount: 0,
      reviewCommentProjectionChangeCount: 0,
      reviewThreadProjectionChangeCount: 0,
      reviewProjectionChangeCount: 0,
      statusCheckProjectionChangeCount: 0,
      skippedBranchCount: 0,
      dryRun: true,
      ownerApprovalRequired: true,
      failures: [],
    });
    startPostConnectBackfillMock.mockResolvedValue({
      claimed: true,
      completion: Promise.resolve(null),
    });
  });

  it("rejects a missing installationId before looking up the organization", async () => {
    const response = await POST(connectRequest("{}"), EMPTY_CONTEXT);

    expect(response.status).toBe(400);
    expect(findByClerkIdMock).not.toHaveBeenCalled();
    expect(claimGitHubInstallationMock).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body before looking up the organization", async () => {
    const response = await POST(connectRequest("not-json"), EMPTY_CONTEXT);

    expect(response.status).toBe(400);
    expect(findByClerkIdMock).not.toHaveBeenCalled();
    expect(claimGitHubInstallationMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the Clerk organization has no local organization", async () => {
    findByClerkIdMock.mockResolvedValueOnce(null);

    const response = await POST(connectRequest(), EMPTY_CONTEXT);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Organization not found");
    expect(claimGitHubInstallationMock).not.toHaveBeenCalled();
  });

  it("returns link-required recovery code at the top level", async () => {
    claimGitHubInstallationMock.mockResolvedValueOnce({
      status: "error",
      error: "Connect your GitHub account before claiming this installation.",
      code: GitHubConnectErrorCode.LinkRequired,
    });

    const response = await POST(connectRequest(), EMPTY_CONTEXT);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe(GitHubConnectErrorCode.LinkRequired);
    expect(body).not.toHaveProperty("details.code");
  });

  it("schedules the whole shared-writer backfill off the request path after connect", async () => {
    const response = await POST(connectRequest(), EMPTY_CONTEXT);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      connected: true,
      backfill: { status: GitHubBackfillStatus.Running },
    });
    // PLN-1742 M5: the claim carries no OAuth code — a stale deploy's `code`
    // in the request body is stripped by the validator, never forwarded.
    expect(claimGitHubInstallationMock).toHaveBeenCalledWith({
      installationId: "123",
      organizationId: "org-1",
      userId: "user-1",
    });
    // ISS-7408: exactly ONE run, in the background lane. The bounded
    // `repositoryLimit: 1` first slice this route used to await is gone — it
    // cost 32s avg / 70s p95 on the OAuth callback and then the lane below
    // swept the same repository a second time.
    expect(startPostConnectBackfillMock).toHaveBeenCalledTimes(1);
    expect(startPostConnectBackfillMock).toHaveBeenCalledWith({
      approvedForVisibleWrites: true,
      bypassCooldown: true,
      organizationId: "org-1",
    });
    // The durable claim is awaited and only the sweep is backgrounded, so the
    // all-in-one entry point must NOT be what this route reaches for.
    expect(runPostConnectBackfillMock).not.toHaveBeenCalled();
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
  });

  it(
    "returns before the backfill finishes",
    async () => {
      // The SWEEP never resolves; the durable claim does. Re-introducing an
      // await on the sweep hangs this case instead of reddening it, which is
      // why it carries an explicit short timeout.
      startPostConnectBackfillMock.mockResolvedValue({
        claimed: true,
        completion: new Promise(() => undefined),
      });

      const response = await POST(connectRequest(), EMPTY_CONTEXT);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data.backfill).toEqual({
        status: GitHubBackfillStatus.Running,
      });
    },
    NON_BLOCKING_ASSERTION_TIMEOUT_MS
  );

  it("does not start backfill when GitHub requires account confirmation", async () => {
    claimGitHubInstallationMock.mockResolvedValueOnce({
      status: "requires_confirmation",
      priorAccount: { accountId: "old", accountLogin: "old-org" },
      newAccount: { accountId: "new", accountLogin: "new-org" },
      newInstallationId: "installation-new",
    });

    const response = await POST(connectRequest(), EMPTY_CONTEXT);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.connected).toBe(false);
    expect(body.data.status).toBe("requires_confirmation");
    expect(startPostConnectBackfillMock).not.toHaveBeenCalled();
    expect(runPostConnectBackfillMock).not.toHaveBeenCalled();
    expect(waitUntilMock).not.toHaveBeenCalled();
  });

  it("keeps connect successful when the durable backfill claim throws", async () => {
    startPostConnectBackfillMock.mockRejectedValue(new Error("db down"));

    const response = await POST(connectRequest(), EMPTY_CONTEXT);
    const body = await response.json();

    // The installation is already claimed by this point, so a throw here must
    // not answer with a 500 the callback renders as "connection failed" for an
    // org that IS connected (#5689 review). The backfill degraded, not the
    // connection, and the response says exactly that.
    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      connected: true,
      backfill: { status: GitHubBackfillStatus.Degraded },
    });
    expect(waitUntilMock).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalledWith(
      "github.connect.backfill_claim_failed",
      expect.objectContaining({ organizationId: "org-1" })
    );
  });

  it("keeps connect successful when the background backfill fails", async () => {
    startPostConnectBackfillMock.mockResolvedValue({
      claimed: true,
      completion: Promise.reject(new Error("provider unavailable")),
    });

    const response = await POST(connectRequest(), EMPTY_CONTEXT);
    const body = await response.json();
    await waitUntilMock.mock.calls[0]?.[0];

    // The claim succeeded; a provider failure in the sweep that follows it must
    // not turn a connected installation into a failed connect.
    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      connected: true,
      backfill: { status: GitHubBackfillStatus.Running },
    });
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    // Previously swallowed by `.catch(() => undefined)`. Nobody is waiting on
    // this lane, so an operator is the only remaining reader.
    expect(logErrorMock).toHaveBeenCalledWith(
      "github.connect.background_backfill_failed",
      expect.objectContaining({ organizationId: "org-1" })
    );
  });
});

function connectRequest(
  body = JSON.stringify({ code: "oauth-code", installationId: "123" })
): NextRequest {
  return new NextRequest("http://localhost:3002/integrations/github/connect", {
    method: "POST",
    body,
  });
}
