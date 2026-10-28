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
import { GitHubCapabilityTtlMs } from "@/lib/github/github-access";
import { getGitHubClient } from "@/lib/github/github-client-resolver";
import {
  APP_USER_CONNECTION,
  jsonResponse,
  makeResolverDb,
  NOW,
  okFetch,
  USER_TARGET_INPUT,
  type WithDbMock,
  wireClerkServedToken,
  wireDb,
} from "./github-access-test-fixtures";

const mockWithDb = withDb as unknown as WithDbMock;
const mockClerkClient = clerkClient as unknown as ReturnType<typeof vi.fn>;

// Probe outcomes on a cache miss: classification of each probe result,
// verdict persistence (granularity, TTLs, best-effort), and probe
// single-flighting. Cache READ semantics live in
// github-client-resolver-cache.test.ts.
describe("getGitHubClient (probe outcomes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireClerkServedToken(mockClerkClient);
  });

  it("probes the repo on a cache miss and caches a positive verdict", async () => {
    const db = makeResolverDb({ ...APP_USER_CONNECTION, lastUsedAt: NOW });
    wireDb(mockWithDb, db);
    const fetchMock = okFetch();

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const probeUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(probeUrl).toContain("/repos/Acme/Widgets");
    // The verdict persists at REPO granularity (normalized) — one repo's
    // probe outcome must never govern its siblings under the same owner.
    expect(db.gitHubAccessCapability.create).toHaveBeenCalledWith({
      data: {
        githubUserConnectionId: "connection-1",
        normalizedTargetOwner: "acme",
        targetRepo: "widgets",
        organizationId: "org-1",
        targetOwner: "Acme",
        credentialKind: GitHubCredentialKind.OauthUser,
        denialReason: null,
        installationId: null,
        checkedAt: NOW,
        expiresAt: new Date(NOW.getTime() + GitHubCapabilityTtlMs.Positive),
      },
      // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
      select: { id: true },
    });
    // And the folded cache read filters at the same granularity.
    const readArg = db.gitHubUserConnection.findUnique.mock.calls[0]?.[0];
    expect(readArg?.select?.capabilities?.where).toEqual({
      normalizedTargetOwner: "acme",
      targetRepo: "widgets",
      expiresAt: { gt: NOW },
      checkedAt: {
        gt: new Date(NOW.getTime() - GitHubCapabilityTtlMs.Positive),
      },
    });
  });

  it("probes an owner-only target with the liveness probe and caches at owner level", async () => {
    const db = makeResolverDb({ ...APP_USER_CONNECTION, lastUsedAt: NOW });
    wireDb(mockWithDb, db);
    const fetchMock = okFetch();

    const result = await getGitHubClient(
      { ...USER_TARGET_INPUT, target: { owner: "Acme" } },
      { now: NOW, fetch: fetchMock }
    );

    expect(result.ok).toBe(true);
    const probeUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(probeUrl).toContain("/users/Acme");
    expect(db.gitHubAccessCapability.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        normalizedTargetOwner: "acme",
        targetRepo: null,
      }),
      // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
      select: { id: true },
    });
  });

  it("caches a short-TTL no_installation verdict on a 404 probe", async () => {
    const db = makeResolverDb({ ...APP_USER_CONNECTION, lastUsedAt: NOW });
    wireDb(mockWithDb, db);
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(404, { message: "Not Found" }))
    );

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NoInstallation },
    });
    expect(db.gitHubAccessCapability.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        denialReason: GitHubAccessDenialReason.NoInstallation,
        targetRepo: "widgets",
        expiresAt: new Date(NOW.getTime() + GitHubCapabilityTtlMs.Negative),
      }),
      // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
      select: { id: true },
    });
  });

  it("returns revoked on a 401 probe and caches nothing", async () => {
    // The revocation write this used to assert was a compare-and-set on the
    // stored cipher, and PLN-1742's M5 tail removed the stored credential —
    // Clerk owns the token, so a 401 is not ours to record against the row.
    // The DENIAL the caller sees is unchanged.
    const db = makeResolverDb({ ...APP_USER_CONNECTION, lastUsedAt: NOW });
    wireDb(mockWithDb, db);
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(401, { message: "Bad credentials" }))
    );

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Revoked },
    });
    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
    // Transient credential death is never cached as a capability verdict.
    expect(db.gitHubAccessCapability.create).not.toHaveBeenCalled();
  });

  it("returns rate_limited with the provider ETA and caches nothing", async () => {
    const db = makeResolverDb({ ...APP_USER_CONNECTION, lastUsedAt: NOW });
    wireDb(mockWithDb, db);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          403,
          { message: "API rate limit exceeded for user" },
          { "retry-after": "30" }
        )
      )
    );

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        reason: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 30,
      },
    });
    expect(db.gitHubAccessCapability.create).not.toHaveBeenCalled();
    expect(db.gitHubAccessCapability.updateMany).not.toHaveBeenCalled();
  });

  it("returns unavailable on a 5xx probe and caches nothing", async () => {
    const db = makeResolverDb({ ...APP_USER_CONNECTION, lastUsedAt: NOW });
    wireDb(mockWithDb, db);
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(502, { message: "Bad gateway" }))
    );

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });
    expect(db.gitHubAccessCapability.create).not.toHaveBeenCalled();
  });

  it("single-flights concurrent probes for the same connection and owner", async () => {
    const db = makeResolverDb({ ...APP_USER_CONNECTION, lastUsedAt: NOW });
    wireDb(mockWithDb, db);
    let resolveProbe: (() => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveProbe = () => resolve(jsonResponse(200, { id: 1 }));
        })
    );

    const first = getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });
    const second = getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });
    await vi.waitFor(() => {
      expect(resolveProbe).toBeDefined();
    });
    resolveProbe?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not share a single-flight probe across different repos", async () => {
    const db = makeResolverDb({ ...APP_USER_CONNECTION, lastUsedAt: NOW });
    wireDb(mockWithDb, db);
    const fetchMock = okFetch();

    const [first, second] = await Promise.all([
      getGitHubClient(USER_TARGET_INPUT, { now: NOW, fetch: fetchMock }),
      getGitHubClient(
        { ...USER_TARGET_INPUT, target: { owner: "Acme", repo: "gadgets" } },
        { now: NOW, fetch: fetchMock }
      ),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the usable client even when verdict persistence fails", async () => {
    // Verdict caching is best-effort: a cache-write hiccup must not turn a
    // successful probe into a failure.
    const db = makeResolverDb({ ...APP_USER_CONNECTION, lastUsedAt: NOW });
    db.gitHubAccessCapability.updateMany.mockRejectedValue(
      new Error("db unavailable")
    );
    db.gitHubAccessCapability.create.mockRejectedValue(
      new Error("db unavailable")
    );
    wireDb(mockWithDb, db);

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: okFetch(),
    });

    expect(result.ok).toBe(true);
  });
});
