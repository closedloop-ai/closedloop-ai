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

vi.mock("@/lib/integration-encryption", () => ({
  decryptIntegrationToken: vi.fn(),
}));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { withDb } from "@repo/database";
import type { GitHubClient } from "@/lib/github/github-access";
import { getGitHubClient } from "@/lib/github/github-client-resolver";
import {
  APP_USER_CONNECTION,
  makeResolverDb,
  mockDecrypt,
  NOW,
  okFetch,
  USER_TARGET_INPUT,
  type WithDbMock,
  wireDb,
} from "./github-access-test-fixtures";

const mockWithDb = withDb as unknown as WithDbMock;

// Verdict-cache READ semantics: when a stored capability row may answer for
// the credential without a probe, and when it must be treated as a miss.
// Probe outcomes and verdict persistence live in
// github-client-resolver-probe.test.ts.
describe("getGitHubClient (verdict-cache reads)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecrypt.mockResolvedValue("decrypted-token");
  });

  it("serves a cached positive verdict without any GitHub request", async () => {
    const db = makeResolverDb({
      ...APP_USER_CONNECTION,
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.GithubAppUser,
          denialReason: null,
          installationId: null,
          checkedAt: new Date("2026-07-30T11:58:00.000Z"),
          expiresAt: new Date("2026-07-30T12:10:00.000Z"),
        },
      ],
    });
    wireDb(mockWithDb, db);
    const fetchMock = okFetch();

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result.ok).toBe(true);
    const client = (result as { ok: true; value: GitHubClient }).value;
    expect(client.kind).toBe(GitHubCredentialKind.GithubAppUser);
    expect(client.actingAs).toEqual({ githubUserId: "9001", login: "octocat" });
    expect(client.rateLimitTier).toBe(15_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.gitHubAccessCapability.create).not.toHaveBeenCalled();
    expect(db.gitHubAccessCapability.updateMany).not.toHaveBeenCalled();
  });

  it("serves a cached denial verdict without any GitHub request", async () => {
    wireDb(
      mockWithDb,
      makeResolverDb({
        ...APP_USER_CONNECTION,
        capabilities: [
          {
            credentialKind: GitHubCredentialKind.GithubAppUser,
            denialReason: GitHubAccessDenialReason.NoInstallation,
            installationId: null,
            checkedAt: new Date("2026-07-30T11:58:00.000Z"),
            expiresAt: new Date("2026-07-30T12:04:00.000Z"),
          },
        ],
      })
    );
    const fetchMock = okFetch();

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NoInstallation },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an unknown cached denial reason as a miss and reprobes", async () => {
    const db = makeResolverDb({
      ...APP_USER_CONNECTION,
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.GithubAppUser,
          // A newer writer cached a code this build does not know.
          denialReason: "quota_exceeded_v9",
          installationId: null,
          checkedAt: new Date("2026-07-30T11:58:00.000Z"),
          expiresAt: new Date("2026-07-30T12:04:00.000Z"),
        },
      ],
    });
    wireDb(mockWithDb, db);
    const fetchMock = okFetch();

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reprobes when the cached verdict belongs to the other credential family", async () => {
    // A reconnect overwrote the scopes (flipping the derived family) but the
    // capability rows survived — the stale OAuth-family denial must not bind
    // the App-family credential.
    const db = makeResolverDb({
      ...APP_USER_CONNECTION,
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.OauthUser,
          denialReason: GitHubAccessDenialReason.NoInstallation,
          installationId: null,
          checkedAt: new Date("2026-07-30T11:58:00.000Z"),
          expiresAt: new Date("2026-07-30T12:04:00.000Z"),
        },
      ],
    });
    wireDb(mockWithDb, db);
    const fetchMock = okFetch();

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a sync-written negative older than the 5m negative TTL as a miss", async () => {
    // The sync lane persists 6h expiries into shared repo-level rows; the
    // interactive lane must still re-check negatives at its own short TTL.
    const db = makeResolverDb({
      ...APP_USER_CONNECTION,
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.GithubAppUser,
          denialReason: GitHubAccessDenialReason.NoInstallation,
          installationId: null,
          checkedAt: new Date("2026-07-30T11:54:00.000Z"),
          expiresAt: new Date("2026-07-30T17:54:00.000Z"),
        },
      ],
    });
    wireDb(mockWithDb, db);
    const fetchMock = okFetch();

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
