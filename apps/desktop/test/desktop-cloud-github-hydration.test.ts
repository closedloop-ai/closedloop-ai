import assert from "node:assert/strict";
import { test } from "node:test";
import type { BranchRow } from "@repo/api/src/types/branch";
import {
  BranchCloudHydrationStatus,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  GitHubPRState,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import { DesktopCloudGitHubHydration } from "../src/main/cloud/desktop-cloud-github-hydration.js";

const BRANCH_ROW: BranchRow = {
  id: "closedloop-ai/symphony-alpha::fea-2382",
  branchName: "fea-2382",
  baseBranch: null,
  repoFullName: "closedloop-ai/symphony-alpha",
  owner: null,
  status: BranchStatus.Open,
  prNumber: 123,
  prTitle: "Test PR",
  prState: GitHubPRState.Open,
  prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/123",
  multiPrWarning: false,
  checksStatus: null,
  checksPassed: null,
  checksTotal: null,
  reviewDecision: null,
  ahead: null,
  behind: null,
  additions: null,
  deletions: null,
  filesChanged: null,
  estimatedCostUsd: null,
  lastActivityAt: "2026-07-05T00:00:00.000Z",
  sessionIds: [],
};

// PLN-1535 M3.2: the two no-hydration reasons are DIFFERENT claims and must
// reach the renderer as different states. Repo identity present + no credential
// is a SIGN-IN problem (`CredentialMissing`); no repo identity anywhere is a
// GitHub-CONNECT problem (`NotConnected`). Collapsing both to `NotConnected`
// pointed a signed-out user at a connect-GitHub CTA that could never help them.
test("reports credential-missing when repos are known but no credential exists", async () => {
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
  });

  const result = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
  });

  assert.deepEqual(result, {
    status: BranchCloudHydrationStatus.CredentialMissing,
  });
});

test("reports not-connected when no row carries a repo identity", async () => {
  const hydration = new DesktopCloudGitHubHydration({
    // A credential IS available, so the refusal can only be about repo
    // identity — this is the half of the split that must NOT become
    // CredentialMissing.
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: () => {
      throw new Error("must not fetch without any repo identity");
    },
  });

  const result = await hydration.hydrate({
    rows: [{ ...BRANCH_ROW, repoFullName: null }],
    scope: "list",
  });

  assert.deepEqual(result, {
    status: BranchCloudHydrationStatus.NotConnected,
  });
});

test("coalesces cloud reads behind the list TTL", async () => {
  let now = 1000;
  let fetchCloudCalls = 0;
  let writeOverlaysCalls = 0;
  const fetchCloud = (url: URL | RequestInfo, _init?: RequestInit) => {
    fetchCloudCalls += 1;
    return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
  };
  const writeOverlays = () => {
    writeOverlaysCalls += 1;
    return Promise.resolve();
  };
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    now: () => now,
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays,
    },
    fetch: fetchCloud,
  });

  const first = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
  });
  now += 1000;
  const second = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
  });

  assert.equal(first.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(
    first.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.prTitle,
    "Cloud PR"
  );
  assert.equal(
    first.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.baseBranch,
    "main"
  );
  assert.equal(
    "owner" in
      (first.overlays?.["closedloop-ai/symphony-alpha::fea-2382"] ?? {}),
    false,
    "PR author is not canonical Branch Owner evidence"
  );
  assert.equal(
    first.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.checksStatus,
    ChecksStatus.Passing
  );
  assert.equal(
    first.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.reviewDecision,
    ReviewDecision.Approved
  );
  assert.equal(
    first.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.additions,
    120
  );
  assert.equal(
    first.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.deletions,
    30
  );
  assert.equal(
    first.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.filesChanged,
    6
  );
  assert.equal(
    first.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.mergedAt,
    null
  );
  assert.equal(second.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(fetchCloudCalls, 3);
  assert.equal(writeOverlaysCalls, 1);
});

test("fresh hydration does not block on overlay persistence", async () => {
  let resolveWriteStarted: () => void = () => undefined;
  let releaseWrite: () => void = () => undefined;
  const writeStarted = new Promise<void>((resolve) => {
    resolveWriteStarted = resolve;
  });
  const writeRelease = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: () => {
        resolveWriteStarted();
        return writeRelease;
      },
    },
    fetch: (url) =>
      Promise.resolve(Response.json(successBodyForUrl(url.toString()))),
  });

  const hydrationPromise = hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
  });
  let settled = false;
  const observedHydration = hydrationPromise.then((result) => {
    settled = true;
    return result;
  });

  await writeStarted;
  for (let index = 0; index < 10 && !settled; index += 1) {
    await Promise.resolve();
  }
  try {
    assert.equal(settled, true);
  } finally {
    releaseWrite();
  }
  const result = await observedHydration;
  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
});

test("skips public repositories before pulling branch and PR overlays", async () => {
  const urls: string[] = [];
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) => {
      const requestUrl = new URL(url.toString());
      urls.push(requestUrl.toString());
      if (requestUrl.pathname === "/integrations/github/repositories") {
        return Promise.resolve(
          Response.json({
            success: true,
            data: [
              {
                id: "repo-public",
                fullName: "closedloop-ai/symphony-alpha",
                name: "symphony-alpha",
                owner: "closedloop-ai",
                private: false,
                githubRepoId: "1",
                source: GitHubRepositorySource.Public,
              },
              {
                id: "repo-1",
                fullName: "closedloop-ai/symphony-alpha",
                name: "symphony-alpha",
                owner: "closedloop-ai",
                private: true,
                githubRepoId: "1",
                source: GitHubRepositorySource.Installation,
              },
            ],
          })
        );
      }
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  const result = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "detail",
  });

  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(
    urls.some((url) => url.includes("/repositories/repo-public/")),
    false
  );
  assert.equal(
    urls.some((url) => url.includes("/repositories/repo-1/pull-requests")),
    true
  );
});

test("manual refresh bypasses the cache", async () => {
  let urls = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) => {
      urls += 1;
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
    forceRefresh: true,
  });

  assert.equal(urls, 6);
});

test("expired cache returns stale overlays when a refresh pull fails", async () => {
  let now = 1000;
  let fail = false;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    now: () => now,
    fetch: (url) => {
      if (fail) {
        return Promise.resolve(new Response("nope", { status: 503 }));
      }
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "detail" });
  now += 31_000;
  fail = true;
  const result = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "detail",
  });

  assert.equal(result.status, BranchCloudHydrationStatus.Stale);
  assert.equal(result.failure, "cloud_pull_failed");
  assert.equal(
    result.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.prTitle,
    "Cloud PR"
  );
});

test("failed cloud pull returns persisted overlays when memory cache is empty", async () => {
  const persistedOverlays = {
    "closedloop-ai/symphony-alpha::fea-2382": {
      prTitle: "Persisted Cloud PR",
      checksStatus: ChecksStatus.Passing,
    },
  };
  const reads: Array<{ identityKey: string; repoNames: readonly string[] }> =
    [];
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    store: {
      readOverlays: (identityKey, repoNames) => {
        reads.push({ identityKey, repoNames });
        return Promise.resolve(persistedOverlays);
      },
      writeOverlays: () => Promise.resolve(),
    },
    fetch: async () => new Response("nope", { status: 503 }),
  });

  const result = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "detail",
  });

  assert.equal(result.status, BranchCloudHydrationStatus.Stale);
  assert.equal(result.failure, "cloud_pull_failed");
  assert.equal(
    result.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.prTitle,
    "Persisted Cloud PR"
  );
  assert.deepEqual(reads[0]?.repoNames, ["closedloop-ai/symphony-alpha"]);
});

test("cache entries are isolated by API key and identity scope", async () => {
  let apiKey = "sk_live_first";
  let organizationId = "org-1";
  let urls = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => apiKey,
    getApiOrigin: () => "https://api.example.test",
    getIdentityScope: () => ({ organizationId, userId: "user-1" }),
    fetch: (url) => {
      urls += 1;
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  apiKey = "sk_live_second";
  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  organizationId = "org-2";
  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });

  assert.equal(urls, 9);
});

test("returns failed status when a cloud pull fails", async () => {
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: async () => new Response("nope", { status: 503 }),
  });

  const result = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "detail",
  });

  assert.deepEqual(result, {
    status: BranchCloudHydrationStatus.Failed,
    failure: "cloud_pull_failed",
  });
});

test("passes an abort timeout signal on every cloud request", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url, init) => {
      signals.push(init?.signal ?? undefined);
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
  });

  assert.ok(signals.length > 0);
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal);
  }
});

test("the injected timeout aborts a hung cloud request", async () => {
  let sawAbort = false;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    // Drive the real AbortSignal.timeout wiring with a tiny injected bound: the
    // fetch never resolves on its own, so this test only settles (and passes)
    // if the injected timeout actually fires and aborts the request. Removing
    // or breaking the timeout wiring would hang here until the test times out.
    timeoutMs: 5,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal instanceof AbortSignal);
        const failSafeTimer = setTimeout(() => {
          reject(new Error("injected timeout did not abort"));
        }, 1000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(failSafeTimer);
            sawAbort = true;
            reject(signal.reason ?? new Error("aborted"));
          },
          { once: true }
        );
      }),
  });

  const result = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
  });

  assert.equal(sawAbort, true);
  assert.equal(result.status, BranchCloudHydrationStatus.Failed);
  assert.equal(result.failure, "cloud_pull_failed");
});

test("an aborted request settles as a failed pull and frees the dedup slot", async () => {
  let calls = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    // Model the request timeout firing: fetch rejects with an abort error.
    fetch: () => {
      calls += 1;
      return Promise.reject(
        new DOMException("The operation was aborted", "TimeoutError")
      );
    },
  });

  const firstResult = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
  });
  assert.equal(firstResult.status, BranchCloudHydrationStatus.Failed);
  assert.equal(firstResult.failure, "cloud_pull_failed");

  // A subsequent hydrate must issue a fresh request instead of deduping onto
  // the settled (formerly hung) call.
  const secondResult = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
  });
  assert.equal(secondResult.status, BranchCloudHydrationStatus.Failed);
  assert.ok(calls >= 2);
});

// FEA-3056 follow-up: the Branches page-data read must never block first
// paint on a live GitHub round trip (a cold cache measured 5s+ in
// production). `peekOrWarm` is the non-blocking counterpart to `hydrate()`
// that the list/analytics scope uses for exactly that reason.
test("peekOrWarm returns a Stale snapshot without waiting for the cloud fetch, then warms the cache in the background", async () => {
  let resolveRepositories: (value: Response) => void = () => undefined;
  const repositoriesGate = new Promise<Response>((resolve) => {
    resolveRepositories = resolve;
  });
  let notifyBackgroundRefresh: () => void = () => undefined;
  const backgroundRefreshed = new Promise<void>((resolve) => {
    notifyBackgroundRefresh = resolve;
  });
  let backgroundRefreshes = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    onBackgroundRefresh: () => {
      backgroundRefreshes += 1;
      notifyBackgroundRefresh();
    },
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: () => Promise.resolve(),
    },
    fetch: (url) => {
      const requestUrl = new URL(url.toString());
      if (requestUrl.pathname === "/integrations/github/repositories") {
        return repositoriesGate;
      }
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  const result = await hydration.peekOrWarm({
    rows: [BRANCH_ROW],
    scope: "list",
  });
  assert.equal(result.status, BranchCloudHydrationStatus.Stale);
  assert.equal(result.overlays, undefined);
  assert.equal(backgroundRefreshes, 0);

  resolveRepositories(Response.json(successBodyForUrl("/repositories")));
  await backgroundRefreshed;
  assert.equal(backgroundRefreshes, 1);

  const warmed = await hydration.peekOrWarm({
    rows: [BRANCH_ROW],
    scope: "list",
  });
  assert.equal(warmed.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(
    warmed.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.prTitle,
    "Cloud PR"
  );
});

test("peekOrWarm serves a warm in-memory cache hit with no network call", async () => {
  let fetches = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    fetch: (url) => {
      fetches += 1;
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  const callsAfterWarming = fetches;

  const result = await hydration.peekOrWarm({
    rows: [BRANCH_ROW],
    scope: "list",
  });

  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(fetches, callsAfterWarming);
});

test("peekOrWarm falls back to persisted overlays, marked Stale, on a cold memory cache", async () => {
  const persistedOverlays = {
    "closedloop-ai/symphony-alpha::fea-2382": {
      prTitle: "Persisted Cloud PR",
    },
  };
  let neverResolves: Promise<Response> | undefined;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    store: {
      readOverlays: () => Promise.resolve(persistedOverlays),
      writeOverlays: () => Promise.resolve(),
    },
    fetch: () => {
      neverResolves ??= new Promise<Response>(() => undefined);
      return neverResolves;
    },
  });

  const result = await hydration.peekOrWarm({
    rows: [BRANCH_ROW],
    scope: "list",
  });

  assert.equal(result.status, BranchCloudHydrationStatus.Stale);
  assert.equal(
    result.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.prTitle,
    "Persisted Cloud PR"
  );
});

test("peekOrWarm dedups the background fetch it kicks off against an already-pending one", async () => {
  let repositoryFetches = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: () => Promise.resolve(),
    },
    fetch: (url) => {
      const requestUrl = new URL(url.toString());
      if (requestUrl.pathname === "/integrations/github/repositories") {
        repositoryFetches += 1;
      }
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  const [first, second] = await Promise.all([
    hydration.peekOrWarm({ rows: [BRANCH_ROW], scope: "list" }),
    hydration.peekOrWarm({ rows: [BRANCH_ROW], scope: "list" }),
  ]);

  assert.equal(first.status, BranchCloudHydrationStatus.Stale);
  assert.equal(second.status, BranchCloudHydrationStatus.Stale);
  assert.equal(repositoryFetches, 1);
});

test("peekOrWarm reports credential-missing without a credential, like hydrate", async () => {
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
  });

  const result = await hydration.peekOrWarm({
    rows: [BRANCH_ROW],
    scope: "list",
  });

  // Same credential-missing split as `hydrate` — the non-blocking peek path
  // must not regress to the conflated status (PLN-1535 M3.2).
  assert.deepEqual(result, {
    status: BranchCloudHydrationStatus.CredentialMissing,
  });
});

// PLN-1535 M3: the session-auth lane. Cloud hydration was dark (a false
// NotConnected) for every session-auth-only user because the credential gate
// demanded the compute-target sk_live_* key; these tests pin the migration.
// PR #3994 review: the lane is gated AND identity-scoped by the session
// ACCOUNT identity (`session:<orgId>:<userId>`), decided together with the
// token in one resolution — never a machine-wide constant, never a lane the
// token disagrees with.
const SESSION_IDENTITY_A = { userId: "user-1", organizationId: "org-1" };
const SESSION_IDENTITY_B = { userId: "user-2", organizationId: "org-2" };

test("hydrates with only a first-party session token (no API key)", async () => {
  const authHeaders: (string | null)[] = [];
  const hydration = new DesktopCloudGitHubHydration({
    getAccessToken: () => Promise.resolve("session-token-1"),
    getSessionIdentity: () => SESSION_IDENTITY_A,
    getApiOrigin: () => "https://api.example.test",
    fetch: (url, init) => {
      authHeaders.push(new Headers(init?.headers).get("authorization"));
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  const result = await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });

  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(
    result.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.prTitle,
    "Cloud PR"
  );
  assert.ok(authHeaders.length > 0);
  for (const header of authHeaders) {
    assert.equal(header, "Bearer session-token-1");
  }
});

test("prefers the session token over a configured API key", async () => {
  const authHeaders: (string | null)[] = [];
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getAccessToken: () => Promise.resolve("session-token-1"),
    getSessionIdentity: () => SESSION_IDENTITY_A,
    getApiOrigin: () => "https://api.example.test",
    fetch: (url, init) => {
      authHeaders.push(new Headers(init?.headers).get("authorization"));
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  const result = await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });

  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
  for (const header of authHeaders) {
    assert.equal(header, "Bearer session-token-1");
  }
});

test("session token rotation does not split cache or persisted-overlay identity", async () => {
  let tokenSerial = 0;
  let fetches = 0;
  const writes: Array<{ identityKey: string }> = [];
  const hydration = new DesktopCloudGitHubHydration({
    // Every read returns a NEW token, modeling Clerk's ~60s rotation. Cache
    // and store identity must come from the stable account scope, never the
    // token.
    getAccessToken: () => Promise.resolve(`session-token-${++tokenSerial}`),
    getSessionIdentity: () => SESSION_IDENTITY_A,
    getApiOrigin: () => "https://api.example.test",
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: (identityKey) => {
        writes.push({ identityKey });
        return Promise.resolve();
      },
    },
    fetch: (url) => {
      fetches += 1;
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  const fetchesAfterFirst = fetches;
  // Within the TTL a rotated token must still be a cache HIT.
  const second = await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  assert.equal(second.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(fetches, fetchesAfterFirst);

  // A forced refresh (new token again) must persist under the SAME identity,
  // or every rotation would orphan the stale-fallback snapshot.
  await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
    forceRefresh: true,
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.identityKey, writes[1]?.identityKey);
});

// PR #3994 review (the session-lane counterpart to the key isolation test
// above): two accounts on ONE machine must never share cache or persisted
// identity — that sharing is exactly the cross-account overlay leak the P0
// described.
test("session accounts on one machine get distinct cache and persisted identities", async () => {
  let identity = SESSION_IDENTITY_A;
  let fetches = 0;
  const writes: Array<{ identityKey: string }> = [];
  const hydration = new DesktopCloudGitHubHydration({
    getAccessToken: () => Promise.resolve("session-token"),
    getSessionIdentity: () => identity,
    getApiOrigin: () => "https://api.example.test",
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: (identityKey) => {
        writes.push({ identityKey });
        return Promise.resolve();
      },
    },
    fetch: (url) => {
      fetches += 1;
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
  });

  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  const fetchesAfterFirst = fetches;

  // Account switch: the second account must MISS the first account's cache
  // (a fresh fetch) and persist under a different identity key.
  identity = SESSION_IDENTITY_B;
  await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });

  assert.ok(fetches > fetchesAfterFirst);
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0]?.identityKey, writes[1]?.identityKey);
});

test("a session token without a resolved account identity refuses to hydrate", async () => {
  const hydration = new DesktopCloudGitHubHydration({
    // A token exists but the account identity is unresolved: there is no safe
    // cache/persist identity for the data, so the lane must refuse — never
    // hydrate under an account-anonymous key. With no key either, the refusal
    // is a credential one, not a GitHub-connect one (PLN-1535 M3.2).
    getAccessToken: () => Promise.resolve("session-token"),
    getSessionIdentity: () => null,
    getApiOrigin: () => "https://api.example.test",
    fetch: () => {
      throw new Error("must not fetch without a cache identity");
    },
  });

  const result = await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });

  assert.deepEqual(result, {
    status: BranchCloudHydrationStatus.CredentialMissing,
  });
});

test("never falls back to the API key while a session identity is present", async () => {
  const hydration = new DesktopCloudGitHubHydration({
    // The key may belong to a DIFFERENT org than the signed-in session;
    // fetching with it and persisting under the session identity would defeat
    // cross-account isolation. A session-lane token failure degrades to
    // Failed (stale fallback), never to the key.
    getApiKey: () => "sk_live_test",
    getAccessToken: () => Promise.reject(new Error("session ipc unavailable")),
    getSessionIdentity: () => SESSION_IDENTITY_A,
    getApiOrigin: () => "https://api.example.test",
    fetch: () => {
      throw new Error("must not fetch with the fallback key");
    },
  });

  const result = await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });

  assert.deepEqual(result, {
    status: BranchCloudHydrationStatus.Failed,
    failure: "cloud_pull_failed",
  });
});

// PR #3994 review (app.ts thread): during an OFFLINE boot restore the stored
// session (and so the account identity) exists but no token is resolvable.
// The persisted overlays for THAT account must still serve — Failed/Stale,
// never NotConnected.
test("offline session restore serves the account's persisted overlays", async () => {
  const persistedOverlays = {
    "closedloop-ai/symphony-alpha::fea-2382": { prTitle: "Persisted Cloud PR" },
  };
  const reads: string[] = [];
  const hydration = new DesktopCloudGitHubHydration({
    getAccessToken: () => Promise.resolve(null),
    getSessionIdentity: () => SESSION_IDENTITY_A,
    getApiOrigin: () => "https://api.example.test",
    store: {
      readOverlays: (identityKey) => {
        reads.push(identityKey);
        return Promise.resolve(persistedOverlays);
      },
      writeOverlays: () => Promise.resolve(),
    },
  });

  const result = await hydration.peekOrWarm({
    rows: [BRANCH_ROW],
    scope: "list",
  });

  assert.equal(result.status, BranchCloudHydrationStatus.Stale);
  assert.equal(
    result.overlays?.["closedloop-ai/symphony-alpha::fea-2382"]?.prTitle,
    "Persisted Cloud PR"
  );
  assert.ok(reads.length > 0);
});

test("a 401 invalidates the cached session token and fails the pull", async () => {
  let invalidations = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getAccessToken: () => Promise.resolve("session-token-revoked"),
    getSessionIdentity: () => SESSION_IDENTITY_A,
    onUnauthorized: () => {
      invalidations += 1;
    },
    getApiOrigin: () => "https://api.example.test",
    fetch: async () => new Response("unauthorized", { status: 401 }),
  });

  const result = await hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });

  assert.equal(result.status, BranchCloudHydrationStatus.Failed);
  assert.ok(invalidations >= 1);
});

function successBodyForUrl(url: string): unknown {
  if (url.includes("/branches")) {
    return {
      success: true,
      data: {
        branches: [
          {
            name: "fea-2382",
            committedDate: "2026-07-05T01:00:00.000Z",
            isDefault: false,
          },
        ],
      },
    };
  }
  if (url.includes("/pull-requests")) {
    return {
      success: true,
      data: {
        pullRequests: [
          {
            githubId: "pr-123",
            number: 123,
            title: "Cloud PR",
            htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/123",
            headBranch: "fea-2382",
            baseBranch: "main",
            headSha: "abc123",
            state: GitHubPRState.Open,
            isDraft: false,
            additions: 120,
            deletions: 30,
            changedFiles: 6,
            closedAt: null,
            mergedAt: null,
            mergeCommitSha: null,
            updatedAt: "2026-07-05T02:00:00.000Z",
            author: "octocat",
            checksStatus: ChecksStatus.Passing,
            reviewDecision: ReviewDecision.Approved,
          },
        ],
      },
    };
  }
  return {
    success: true,
    data: [
      {
        id: "repo-1",
        fullName: "closedloop-ai/symphony-alpha",
        name: "symphony-alpha",
        owner: "closedloop-ai",
        private: true,
        githubRepoId: "1",
        source: GitHubRepositorySource.Installation,
      },
    ],
  };
}
