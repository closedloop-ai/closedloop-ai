import assert from "node:assert/strict";
import { test } from "node:test";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { createBranchCloudHydration } from "../src/main/dashboard/branch-cloud-hydration-factory.js";

test("factory routes account-scoped selected and fork names through the DB-host authority op", async () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const source = createBranchCloudHydration(
    {
      getApiOrigin: () => "https://api.example.test",
      getAccessToken: () => Promise.resolve(null),
      getSessionIdentity: () => ({
        organizationId: "org-1",
        userId: "user-1",
      }),
      getWindow: () => null,
    },
    (name, args = []) => {
      calls.push({ name, args });
      if (name === "cloudGithubOverlays.read") {
        return Promise.resolve({
          "base/repository::feature/fork": {
            headRepositoryProvider: VcsProviderKind.GitHub,
            headRepositoryProviderId: "fork-1",
            headRepositoryFullName: "fork-owner/repository",
          },
        });
      }
      if (name === "repositoryDefaultAuthorities.readByRepositoryNames") {
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    }
  );

  assert.ok(source?.resolveRepositoryDefaultEligibilityInputs);
  const result = await source.resolveRepositoryDefaultEligibilityInputs({
    rows: [{ repoFullName: "base/repository", branchName: "feature/fork" }],
    scope: "list",
  });
  const read = calls.find(
    (call) => call.name === "repositoryDefaultAuthorities.readByRepositoryNames"
  );

  assert.deepEqual(result.authorities, []);
  assert.deepEqual(read?.args[1], [
    { provider: VcsProviderKind.GitHub, fullName: "base/repository" },
    { provider: VcsProviderKind.GitHub, fullName: "fork-owner/repository" },
  ]);
});
