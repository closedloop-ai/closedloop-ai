import assert from "node:assert/strict";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { test } from "vitest";
import { readAgentComponentInvocationPage } from "../src/main/dashboard/local-invocation-read.js";
import { insertInvocations } from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const repoFullName = "closedloop-ai/closedloop-ai";

test("ISS-5828: invocation evidence retains rows but presents no branch identity without an authority", async () => {
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

    const page = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      "authority-check",
      []
    );
    assert.equal(page?.total, 4, "branch policy does not delete evidence");
    // Desktop holds no repository-default authority (the cloud owns Branch
    // eligibility), so no branch name can be presented as a verdict.
    assert.deepEqual(branchFieldsById(page?.items ?? []), {
      "inv-0": { repositoryFullName: repoFullName },
      "inv-1": { repositoryFullName: repoFullName },
      "inv-2": { repositoryFullName: repoFullName },
      "inv-3": { repositoryFullName: repoFullName },
    });
  } finally {
    await close();
  }
});

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
