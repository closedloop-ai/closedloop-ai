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
import { DesktopCloudGitHubHydration } from "../src/main/desktop-cloud-github-hydration.js";

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

test("returns not-connected without an API key", async () => {
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => null,
    getApiOrigin: () => "https://api.example.test",
  });

  const result = await hydration.hydrate({
    rows: [BRANCH_ROW],
    scope: "list",
  });

  assert.deepEqual(result, {
    status: BranchCloudHydrationStatus.NotConnected,
  });
});

test("coalesces cloud reads behind the list TTL", async () => {
  let now = 1000;
  const urls: string[] = [];
  const writes: unknown[] = [];
  const hydration = new DesktopCloudGitHubHydration({
    getApiKey: () => "sk_live_test",
    getApiOrigin: () => "https://api.example.test",
    now: () => now,
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: (...args) => {
        writes.push(args);
        return Promise.resolve();
      },
    },
    fetch: (url) => {
      urls.push(url.toString());
      return Promise.resolve(Response.json(successBodyForUrl(url.toString())));
    },
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
  assert.equal(second.status, BranchCloudHydrationStatus.Fresh);
  assert.equal(urls.length, 3);
  assert.equal(writes.length, 1);
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
