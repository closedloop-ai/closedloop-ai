/**
 * @file repository-default-authority-integrity.test.ts
 * @description ISS-5838 real-SQLite coverage proving malformed persisted
 * authority rows reach the regularly wired store-integrity probe without row
 * content or repository/account identity.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createWiredStoreIntegrityProbe } from "../src/main/database/store-integrity-wiring.js";

const OBSERVED_AT = "2026-08-11T01:00:00.000Z";

test("malformed authority rows reach the production-wired integrity probe content-free", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "repository-default-authority-integrity-")
  );
  const database = await openSqliteAgentDatabase({
    dataDir: path.join(directory, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered",
  });
  try {
    await database.run(
      `INSERT INTO repository_default_authorities (
         identity_key, provider, provider_repository_id, repo_full_name,
         default_branch, availability, completeness, source, mechanism,
         trigger, credential_type, observation_key, observed_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
      "account-secret",
      VcsProviderKind.GitHub,
      "repository-secret",
      "private/repository",
      "main",
      RepositoryDefaultAvailability.Available,
      RepositoryDefaultCompleteness.Complete,
      RepositoryDefaultSource.RepositoryRest,
      GitHubFetchMechanism.Rest,
      GitHubFetchTrigger.SurfaceOpen,
      GitHubFetchCredentialType.GitHubApp,
      "observation-secret",
      OBSERVED_AT
    );
    // Fill the first 100-row page. `account-secret` sorts after these rows, so
    // corrupting it below proves the cursor scan reaches a second page without
    // hydrating the whole table at once.
    await database.run(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 99
       )
       INSERT INTO repository_default_authorities (
         identity_key, provider, provider_repository_id, repo_full_name,
         default_branch, availability, completeness, source, mechanism,
         trigger, credential_type, observation_key, observed_at, updated_at
       )
       SELECT
         'account-' || value, $1, 'repository-' || value,
         'public/repository-' || value, 'main', $2, $3, $4, $5, $6, $7,
         'observation-' || value, $8, $8
       FROM sequence`,
      VcsProviderKind.GitHub,
      RepositoryDefaultAvailability.Available,
      RepositoryDefaultCompleteness.Complete,
      RepositoryDefaultSource.RepositoryRest,
      GitHubFetchMechanism.Rest,
      GitHubFetchTrigger.SurfaceOpen,
      GitHubFetchCredentialType.GitHubApp,
      OBSERVED_AT
    );

    const probe = createWiredStoreIntegrityProbe({
      agentDatabase: database,
      emit: () => {},
      getIngestProgress: () => ({ preparing: false, total: 0, processed: 0 }),
      log: () => {},
    });
    assert.deepEqual(
      (await probe.runOnce()).issues.filter(
        (issue) => issue.check === "repository_default_authority"
      ),
      []
    );

    await database.run(
      `UPDATE repository_default_authorities
       SET observed_at = $1
       WHERE identity_key = $2`,
      "not-an-iso-timestamp",
      "account-secret"
    );
    const diagnostics = await probe.runOnce();

    assert.ok(diagnostics.checksRun.includes("repository_default_authority"));
    assert.deepEqual(
      diagnostics.issues.filter(
        (issue) => issue.check === "repository_default_authority"
      ),
      [
        {
          check: "repository_default_authority",
          category: "malformed_repository_default_authority",
          object: "repository_default_authorities",
          objectType: "table",
        },
      ]
    );
    assert.equal(JSON.stringify(diagnostics).includes("account-secret"), false);
    assert.equal(
      JSON.stringify(diagnostics).includes("repository-secret"),
      false
    );
  } finally {
    await database.close();
    await rm(directory, { force: true, recursive: true });
  }
});
