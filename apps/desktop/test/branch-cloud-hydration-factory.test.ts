import assert from "node:assert/strict";
import { test } from "node:test";
import type { BranchRow } from "@repo/api/src/types/branch";
import {
  BranchCloudHydrationStatus,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  GitHubPRState,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { createBranchCloudHydration } from "../src/main/dashboard/branch-cloud-hydration-factory.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";

// Exercise factory behavior because hydration unit tests cannot detect broken
// production gates or dependency wiring.

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

const invokeStoreOp = () => Promise.resolve(undefined);

test("returns undefined when no credential source is wired", () => {
  const source = createBranchCloudHydration(
    { getApiOrigin: () => "https://api.example.test", getWindow: () => null },
    invokeStoreOp
  );
  assert.equal(source, undefined);
});

test("returns undefined without an API origin", () => {
  const source = createBranchCloudHydration(
    {
      getAccessToken: () => Promise.resolve("session-token"),
      getSessionIdentity: () => ({ userId: "u1", organizationId: "o1" }),
      getWindow: () => null,
    },
    invokeStoreOp
  );
  assert.equal(source, undefined);
});

test("authority IPC parsing keeps valid siblings and skips malformed rows", async () => {
  const baseAuthority = authority(
    "closedloop-ai/symphony-alpha",
    "repo-1",
    "main"
  );
  const source = createBranchCloudHydration(
    {
      getApiOrigin: () => "https://api.example.test",
      getApiKey: () => "sk_live_test",
      getWindow: () => null,
      fetch: () =>
        Promise.resolve(
          Response.json({
            success: true,
            data: [
              repository(
                "closedloop-ai/symphony-alpha",
                "repo-1",
                GitHubRepositorySource.Public,
                baseAuthority
              ),
            ],
          })
        ),
    },
    (name) => {
      if (name === "cloudGithubOverlays.read") {
        return Promise.resolve({});
      }
      if (name === "repositoryDefaultAuthorities.readByRepositoryNames") {
        return Promise.resolve([
          baseAuthority,
          { ...baseAuthority, unexpected: true },
          { repository: baseAuthority.repository, evidence: null },
        ]);
      }
      return Promise.resolve(undefined);
    }
  );

  assert.ok(source?.resolveRepositoryDefaultEligibilityInputs);
  const result = await source.resolveRepositoryDefaultEligibilityInputs({
    rows: [
      {
        branchName: BRANCH_ROW.branchName,
        repoFullName: BRANCH_ROW.repoFullName,
      },
    ],
    scope: "detail",
  });

  assert.deepEqual(result.authorities, [baseAuthority]);
});

test("authority IPC parsing rejects a non-array boundary as Failed", async () => {
  const source = createBranchCloudHydration(
    {
      getAccessToken: () => Promise.resolve(null),
      getSessionIdentity: () => ({ userId: "user-1", organizationId: "org-1" }),
      getApiOrigin: () => "https://api.example.test",
      getWindow: () => null,
    },
    (name) =>
      name === "repositoryDefaultAuthorities.readByRepositoryNames"
        ? Promise.resolve({ authority: "not-an-array" })
        : Promise.resolve({})
  );

  assert.ok(source?.resolveRepositoryDefaultEligibilityInputs);
  const result = await source.resolveRepositoryDefaultEligibilityInputs({
    rows: [
      {
        branchName: BRANCH_ROW.branchName,
        repoFullName: BRANCH_ROW.repoFullName,
      },
    ],
    scope: "list",
  });

  assert.equal(result.status, BranchCloudHydrationStatus.Failed);
  assert.deepEqual(result.authorities, []);
});

// The regression: session-only wiring (NO API key) must produce a working
// source that hydrates with the session bearer — not undefined, and not
// NotConnected.
test("session-only wiring hydrates with the session bearer token", async () => {
  const authHeaders: (string | null)[] = [];
  const source = createBranchCloudHydration(
    {
      getApiOrigin: () => "https://api.example.test",
      getAccessToken: () => Promise.resolve("session-token-1"),
      getSessionIdentity: () => ({ userId: "u1", organizationId: "o1" }),
      getWindow: () => null,
      fetch: (url, init) => {
        authHeaders.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          Response.json(successBodyForUrl(url.toString()))
        );
      },
    },
    invokeStoreOp
  );

  assert.ok(source);
  const result = await source.hydrate({ rows: [BRANCH_ROW], scope: "list" });

  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
  assert.ok(authHeaders.length > 0);
  for (const header of authHeaders) {
    assert.equal(header, "Bearer session-token-1");
  }
});

test("factory wires 401 handling to invalidateAccessToken", async () => {
  let invalidations = 0;
  const source = createBranchCloudHydration(
    {
      getApiOrigin: () => "https://api.example.test",
      getAccessToken: () => Promise.resolve("session-token-revoked"),
      getSessionIdentity: () => ({ userId: "u1", organizationId: "o1" }),
      invalidateAccessToken: () => {
        invalidations += 1;
      },
      getWindow: () => null,
      fetch: async () => new Response("unauthorized", { status: 401 }),
    },
    invokeStoreOp
  );

  assert.ok(source);
  const result = await source.hydrate({ rows: [BRANCH_ROW], scope: "list" });

  assert.equal(result.status, BranchCloudHydrationStatus.Failed);
  assert.ok(invalidations >= 1);
});

test("persists public repository authority even when overlays stay empty", async () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const publicAuthority = authority("customer/repository", "public-1", "trunk");
  const source = createBranchCloudHydration(
    {
      getApiOrigin: () => "https://api.example.test",
      getApiKey: () => "sk_live_test",
      getWindow: () => null,
      fetch: () =>
        Promise.resolve(
          Response.json({
            success: true,
            data: [
              repository(
                "customer/repository",
                "public-1",
                GitHubRepositorySource.Public,
                publicAuthority
              ),
            ],
          })
        ),
    },
    (name, args = []) => {
      calls.push({ name, args });
      return Promise.resolve(undefined);
    }
  );

  assert.ok(source);
  const mainRow = {
    ...BRANCH_ROW,
    id: "customer/repository::main",
    repoFullName: "customer/repository",
    branchName: "main",
  };
  const result = await source.hydrate({ rows: [mainRow], scope: "list" });
  const write = calls.find(
    (call) => call.name === "repositoryDefaultAuthorities.write"
  );

  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
  assert.deepEqual(Object.keys(result.overlays ?? {}), []);
  assert.deepEqual(write?.args.slice(1), [[publicAuthority]]);
  assert.equal(typeof write?.args[0], "string");
});

test("dedupes and writes 101 authorities in deterministic bounded chunks", async () => {
  const authorityCount = 101;
  const rows = Array.from({ length: authorityCount }, (_, index) => ({
    ...BRANCH_ROW,
    id: `owner/repository-${index}::main`,
    repoFullName: `owner/repository-${index}`,
    branchName: "main",
  }));
  const repositories = rows.map((row, index) =>
    repository(
      row.repoFullName ?? "",
      `repo-${index}`,
      GitHubRepositorySource.Public,
      authority(row.repoFullName ?? "", `repo-${index}`, `default-${index}`)
    )
  );
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const source = createBranchCloudHydration(
    {
      getApiOrigin: () => "https://api.example.test",
      getApiKey: () => "sk_live_test",
      getWindow: () => null,
      fetch: () =>
        Promise.resolve(
          Response.json({
            success: true,
            data: [...repositories, repositories[0]],
          })
        ),
    },
    (name, args = []) => {
      calls.push({ name, args });
      return Promise.resolve(undefined);
    }
  );

  assert.ok(source);
  const result = await source.hydrate({ rows, scope: "list" });
  const writes = calls.filter(
    (call) => call.name === "repositoryDefaultAuthorities.write"
  );

  assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
  assert.deepEqual(Object.keys(result.overlays ?? {}), []);
  assert.deepEqual(
    writes.map((write) => (write.args[1] as unknown[]).length),
    [100, 1]
  );
  assert.equal(typeof writes[0]?.args[0], "string");
});

test("production factory reports a rejected authority write without changing fresh overlays", {
  timeout: 1000,
}, async () => {
  let integrityEventCount = 0;
  let resolveIntegrityEvent: (event: EnrichedTelemetryEvent) => void;
  const integrityEventPromise = new Promise<EnrichedTelemetryEvent>(
    (resolve) => {
      resolveIntegrityEvent = resolve;
    }
  );
  Observability.init({
    telemetrySend: (event) => {
      if (event.category.startsWith("store.integrity.")) {
        integrityEventCount += 1;
        resolveIntegrityEvent(event);
      }
    },
  });
  const baseAuthority = authority(
    "closedloop-ai/symphony-alpha",
    "repo-1",
    "main"
  );
  const source = createBranchCloudHydration(
    {
      getApiOrigin: () => "https://api.example.test",
      getApiKey: () => "sk_live_test",
      getWindow: () => null,
      fetch: () =>
        Promise.resolve(
          Response.json({
            success: true,
            data: [
              repository(
                "closedloop-ai/symphony-alpha",
                "repo-1",
                GitHubRepositorySource.Public,
                baseAuthority
              ),
            ],
          })
        ),
    },
    (name) => {
      if (name === "repositoryDefaultAuthorities.write") {
        return Promise.reject(new Error("authority write rejected"));
      }
      return Promise.resolve(undefined);
    }
  );

  try {
    assert.ok(source);
    const result = await source.hydrate({ rows: [BRANCH_ROW], scope: "list" });
    const integrityEvent = await integrityEventPromise;

    assert.equal(result.status, BranchCloudHydrationStatus.Fresh);
    assert.deepEqual(Object.keys(result.overlays ?? {}), []);
    assert.equal(integrityEventCount, 1);
    assert.equal(
      integrityEvent.message,
      "Repository default authority persistence failed"
    );
    assert.deepEqual(integrityEvent.trace, {
      commandId: "",
      operationId: "",
      computeTargetId: "",
    });
    assert.deepEqual(integrityEvent.diagnostics?.storeIntegrity, {
      healthy: false,
      durationMs: 0,
      checksRun: ["repository_default_authority"],
      issueCount: 1,
      issues: [
        {
          check: "repository_default_authority",
          category: "repository_default_authority_write_failure",
          object: "repository_default_authorities",
          objectType: "table",
        },
      ],
      truncated: false,
    });
  } finally {
    Observability.reset();
  }
});

test("persists successful repository and PR authority when a sibling overlay request fails", async () => {
  const baseAuthority = authority(
    "closedloop-ai/symphony-alpha",
    "base-1",
    "trunk"
  );
  const forkAuthority = authority("fork-owner/repository", "fork-1", "custom");
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const source = createBranchCloudHydration(
    {
      getApiOrigin: () => "https://api.example.test",
      getApiKey: () => "sk_live_test",
      getWindow: () => null,
      fetch: (url) => {
        if (url.toString().endsWith("/repositories")) {
          return Promise.resolve(
            Response.json({
              success: true,
              data: [
                repository(
                  "closedloop-ai/symphony-alpha",
                  "base-1",
                  GitHubRepositorySource.Installation,
                  baseAuthority
                ),
              ],
            })
          );
        }
        if (url.toString().includes("/branches")) {
          return Promise.reject(new Error("branch overlay unavailable"));
        }
        const body = successBodyForUrl(url.toString()) as {
          data: { pullRequests: Record<string, unknown>[] };
        };
        body.data.pullRequests[0] = {
          ...body.data.pullRequests[0],
          headRepository: forkAuthority,
        };
        return Promise.resolve(Response.json(body));
      },
    },
    (name, args = []) => {
      calls.push({ name, args });
      if (name === "cloudGithubOverlays.read") {
        return Promise.resolve({
          [BRANCH_ROW.id]: { prTitle: "Persisted Cloud PR" },
        });
      }
      return Promise.resolve(undefined);
    }
  );

  assert.ok(source);
  const result = await source.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  const write = calls.find(
    (call) => call.name === "repositoryDefaultAuthorities.write"
  );
  const observations = write?.args[1] as Array<{
    repository: { fullName: string };
  }>;

  assert.equal(result.status, BranchCloudHydrationStatus.Stale);
  assert.equal(result.overlays?.[BRANCH_ROW.id]?.prTitle, "Cloud PR");
  assert.deepEqual(
    observations.map((item) => item.repository.fullName),
    ["closedloop-ai/symphony-alpha", "fork-owner/repository"]
  );
  assert.ok(
    calls.some((call) => call.name === "cloudGithubOverlays.write"),
    "fulfilled overlay evidence is retained even when a sibling request fails"
  );
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

function authority(
  fullName: string,
  providerRepositoryId: string,
  defaultBranch: string
) {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch,
    },
    provenance: provenance(RepositoryDefaultSource.RepositoryRest, fullName),
  };
}

function provenance(source: RepositoryDefaultSource, observationKey: string) {
  return {
    source,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: GitHubFetchTrigger.SurfaceOpen,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey,
    observedAt: "2026-08-11T00:00:00.000Z",
  };
}

function repository(
  fullName: string,
  githubRepoId: string,
  source: GitHubRepositorySource,
  repositoryDefaultAuthority: unknown
) {
  return {
    id: githubRepoId,
    fullName,
    name: fullName.split("/").at(-1),
    owner: fullName.split("/")[0],
    private: false,
    githubRepoId,
    source,
    repositoryDefaultAuthority,
  };
}
