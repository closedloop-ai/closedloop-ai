import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { BranchCloudHydrationStatus } from "@repo/api/src/types/branch";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { FAIL_CLOSED_BRANCH_CLOUD_HYDRATION_SOURCE } from "../src/main/branch/shared-branches-cloud-hydration.js";
import type { BranchDefaultEligibilitySource } from "../src/main/branch/shared-branches-default-eligibility.js";
import { readAgentComponentInvocationPage } from "../src/main/dashboard/local-invocation-read.js";
import { insertInvocations } from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const repoFullName = "closedloop-ai/symphony-alpha";

test("ISS-5828: invocation evidence retains rows but presents only eligible branch identity", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertInvocations(
      prisma,
      ["main", "trunk", "feature/eligible", null].map(
        (branchName, sequence) => ({
          id: `inv-${sequence}`,
          sessionId: "session-default-authority",
          componentKind: AgentComponentInvocationKind.Skill,
          componentKey: "authority-check",
          anchorKind: AgentComponentInvocationAnchorKind.Session,
          anchorValue: "session-default-authority",
          sequence,
          gitBranch: branchName,
          repositoryFullName: repoFullName,
        })
      )
    );

    const mainDefault = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      "authority-check",
      [],
      eligibilitySource("main")
    );
    assert.equal(
      mainDefault?.total,
      4,
      "branch policy does not delete evidence"
    );
    assert.deepEqual(branchFieldsById(mainDefault?.items ?? []), {
      "inv-0": { repositoryFullName: repoFullName },
      "inv-1": { branchName: "trunk", repositoryFullName: repoFullName },
      "inv-2": {
        branchName: "feature/eligible",
        repositoryFullName: repoFullName,
      },
      "inv-3": { repositoryFullName: repoFullName },
    });

    const trunkDefault = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      "authority-check",
      [],
      eligibilitySource("trunk")
    );
    assert.deepEqual(branchFieldsById(trunkDefault?.items ?? []), {
      "inv-0": { branchName: "main", repositoryFullName: repoFullName },
      "inv-1": { repositoryFullName: repoFullName },
      "inv-2": {
        branchName: "feature/eligible",
        repositoryFullName: repoFullName,
      },
      "inv-3": { repositoryFullName: repoFullName },
    });

    const unavailable = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      "authority-check",
      [],
      FAIL_CLOSED_BRANCH_CLOUD_HYDRATION_SOURCE
    );
    assert.deepEqual(branchFieldsById(unavailable?.items ?? []), {
      "inv-0": { repositoryFullName: repoFullName },
      "inv-1": { repositoryFullName: repoFullName },
      "inv-2": { repositoryFullName: repoFullName },
      "inv-3": { repositoryFullName: repoFullName },
    });
  } finally {
    await close();
  }
});

function eligibilitySource(
  defaultBranch: string
): BranchDefaultEligibilitySource {
  return {
    resolveRepositoryDefaultEligibilityInputs: async () => ({
      status: BranchCloudHydrationStatus.Fresh,
      rowHydrationResult: { status: BranchCloudHydrationStatus.Fresh },
      authorities: [
        {
          repository: {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "repo-iss5828",
            fullName: repoFullName,
          },
          evidence: {
            availability: RepositoryDefaultAvailability.Available,
            completeness: RepositoryDefaultCompleteness.Complete,
            defaultBranch,
          },
        },
      ],
    }),
  };
}

function branchFieldsById(
  rows: readonly {
    id: string;
    branchName?: string;
    repositoryFullName?: string;
  }[]
): Record<string, { branchName?: string; repositoryFullName?: string }> {
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      {
        ...(row.branchName ? { branchName: row.branchName } : {}),
        ...(row.repositoryFullName
          ? { repositoryFullName: row.repositoryFullName }
          : {}),
      },
    ])
  );
}
