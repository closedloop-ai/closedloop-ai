import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: vi.fn(),
}));

// PLN-1742 M5: Clerk is consulted for every org, so these stored-credential
// cases wire it to a stated "no linked account" denial (see beforeEach).
vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { clerkClient } from "@repo/auth/server";
import { withDb } from "@repo/database";
import { GitHubAccessIntent } from "@/lib/github/github-access";
import { getGitHubClient } from "@/lib/github/github-client-resolver";
import {
  makeResolverDb,
  mockGetInstallationOctokit,
  NOW,
  okFetch,
  USER_TARGET_INPUT,
  type WithDbMock,
  wireClerkNoLinkedAccount,
  wireDb,
} from "./github-access-test-fixtures";

const mockWithDb = withDb as unknown as WithDbMock;
const mockClerkClient = clerkClient as unknown as ReturnType<typeof vi.fn>;

// Lane selection: the manage lane's installation resolution, and the user
// lane's registry bookkeeping. The user credential itself comes from Clerk
// (github-client-resolver-clerk.test.ts owns its denials); verdict-cache read
// semantics live in github-client-resolver-cache.test.ts; probe outcomes in
// github-client-resolver-probe.test.ts.
describe("getGitHubClient (user lane)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireClerkNoLinkedAccount(mockClerkClient);
  });

  it("returns not_connected when Clerk cannot serve the caller", async () => {
    wireDb(mockWithDb, makeResolverDb(null));
    const fetchMock = okFetch();

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NotConnected },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getGitHubClient (manage lane)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireClerkNoLinkedAccount(mockClerkClient);
  });

  const MANAGE_INPUT = {
    organizationId: "org-1",
    userId: "user-1",
    target: { owner: "Acme" },
    intent: GitHubAccessIntent.Manage,
  } as const;

  it("returns the installation client when the org installation covers the owner", async () => {
    const db = makeResolverDb(null);
    db.gitHubInstallation.findUnique.mockResolvedValue({
      installationId: "install-77",
      accountLogin: "acme",
      status: "ACTIVE",
    });
    wireDb(mockWithDb, db);
    const octokit = { rest: {} };
    mockGetInstallationOctokit.mockResolvedValue(octokit);

    const result = await getGitHubClient(MANAGE_INPUT);

    expect(result).toEqual({
      ok: true,
      value: {
        octokit,
        kind: GitHubCredentialKind.Installation,
        actingAs: { installationId: "install-77" },
        rateLimitTier: null,
      },
    });
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith("install-77");
  });

  it("classifies installation-token acquisition failures instead of throwing", async () => {
    const db = makeResolverDb(null);
    db.gitHubInstallation.findUnique.mockResolvedValue({
      installationId: "install-77",
      accountLogin: "acme",
      status: "ACTIVE",
    });
    wireDb(mockWithDb, db);
    mockGetInstallationOctokit.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 502 })
    );

    const result = await getGitHubClient(MANAGE_INPUT);

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });
  });

  it("denies no_installation for inactive or owner-mismatched installations", async () => {
    const variants = [
      null,
      { installationId: "i", accountLogin: "acme", status: "SUSPENDED" },
      { installationId: "i", accountLogin: "other-org", status: "ACTIVE" },
    ];
    for (const installation of variants) {
      const db = makeResolverDb(null);
      db.gitHubInstallation.findUnique.mockResolvedValue(installation);
      wireDb(mockWithDb, db);

      const result = await getGitHubClient(MANAGE_INPUT);

      expect(result).toEqual({
        ok: false,
        error: { reason: GitHubAccessDenialReason.NoInstallation },
      });
    }
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
  });
});
