import assert from "node:assert/strict";
import { test } from "node:test";
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
import {
  DB_HOST_STORE_OP_PREFIX,
  dispatchDbHostStoreOp,
} from "../src/main/database/db-host/db-host-store-op-registry.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestPrisma } from "./prisma-test-utils.js";

test("production store IPC dispatch reaches authority write/read ops against real SQLite", async () => {
  const opened = await openTestPrisma();
  const db = { prisma: opened.prisma } as SqliteAgentDatabase;
  const authority = {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "repo-1",
      fullName: "owner/repository",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "trunk",
    },
    provenance: {
      source: RepositoryDefaultSource.RepositoryRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "repo-1",
      observedAt: "2026-08-11T00:00:00.000Z",
    },
  };

  try {
    const writeResult = await dispatchDbHostStoreOp(
      {},
      db,
      `${DB_HOST_STORE_OP_PREFIX}repositoryDefaultAuthorities.write`,
      ["account-1", [authority]]
    );
    const readResult = await dispatchDbHostStoreOp(
      {},
      db,
      `${DB_HOST_STORE_OP_PREFIX}repositoryDefaultAuthorities.read`,
      [
        "account-1",
        [
          {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "repo-1",
          },
        ],
      ]
    );
    const readByNameResult = await dispatchDbHostStoreOp(
      {},
      db,
      `${DB_HOST_STORE_OP_PREFIX}repositoryDefaultAuthorities.readByRepositoryNames`,
      [
        "account-1",
        [
          {
            provider: VcsProviderKind.GitHub,
            fullName: "OWNER/REPOSITORY",
          },
        ],
      ]
    );

    assert.deepEqual(writeResult, { accepted: 1, skipped: 0 });
    assert.deepEqual(readResult, [authority]);
    assert.deepEqual(readByNameResult, [authority]);
  } finally {
    await opened.close();
  }
});
