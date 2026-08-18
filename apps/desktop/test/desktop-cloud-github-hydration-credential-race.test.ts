import assert from "node:assert/strict";
import { test } from "node:test";
import type { BranchRow } from "@repo/api/src/types/branch";
import {
  BranchCloudHydrationStatus,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { DesktopCloudGitHubHydration } from "../src/main/cloud/desktop-cloud-github-hydration.js";

const BRANCH_ROW: BranchRow = {
  id: "owner/repository::feature",
  branchName: "feature",
  baseBranch: null,
  repoFullName: "owner/repository",
  owner: null,
  status: BranchStatus.Open,
  prNumber: 1,
  prTitle: "Feature",
  prState: GitHubPRState.Open,
  prUrl: "https://github.com/owner/repository/pull/1",
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
  lastActivityAt: "2026-08-11T00:00:00.000Z",
  sessionIds: [],
};

test("account switch during token resolution cannot fetch or persist under stale identity", {
  timeout: 1000,
}, async () => {
  let identity = { userId: "user-a", organizationId: "org-a" };
  let resolveToken!: (token: string) => void;
  let signalTokenRequest!: () => void;
  const token = new Promise<string>((resolve) => {
    resolveToken = resolve;
  });
  const tokenRequested = new Promise<void>((resolve) => {
    signalTokenRequest = resolve;
  });
  let fetches = 0;
  let authorityWrites = 0;
  const hydration = new DesktopCloudGitHubHydration({
    getAccessToken: () => {
      signalTokenRequest();
      return token;
    },
    getSessionIdentity: () => identity,
    getApiOrigin: () => "https://api.example.test",
    fetch: () => {
      fetches += 1;
      return Promise.resolve(Response.json({ success: true, data: [] }));
    },
    store: {
      readOverlays: () => Promise.resolve({}),
      writeOverlays: () => Promise.resolve(),
      writeRepositoryDefaultAuthorities: () => {
        authorityWrites += 1;
        return Promise.resolve();
      },
    },
  });

  const pending = hydration.hydrate({ rows: [BRANCH_ROW], scope: "list" });
  await tokenRequested;
  identity = { userId: "user-b", organizationId: "org-b" };
  resolveToken("token-resolved-after-switch");

  assert.deepEqual(await pending, {
    status: BranchCloudHydrationStatus.CredentialMissing,
  });
  assert.equal(fetches, 0);
  assert.equal(authorityWrites, 0);
});
