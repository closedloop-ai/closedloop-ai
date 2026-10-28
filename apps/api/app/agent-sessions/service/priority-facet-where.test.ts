/**
 * ISS-10332 — the Sessions `priorities` facet, through the production
 * `buildWhere` seam every list, usage and export read resolves through.
 */
import { Priority } from "@repo/api/src/types/common";
import type { PriorityFilterValue } from "@repo/api/src/types/priority-filter";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionListQuery } from "../validators";
import { buildWhere } from "./query-builder";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

const ORG_ID = "org_1";

async function artifactWhereFor(priorities: PriorityFilterValue[] | undefined) {
  const where = await buildWhere(
    { organizationId: ORG_ID },
    { quality: "all", priorities } as AgentSessionListQuery,
    "lastActivityAt"
  );
  return where.artifact?.is;
}

describe("Sessions priority facet (ISS-10332)", () => {
  it("filters on the parent artifact, ORing the members with the unset arm", async () => {
    expect(
      await artifactWhereFor([
        Priority.High,
        PRIORITY_UNSET_VALUE,
        Priority.Low,
      ])
    ).toEqual({
      organizationId: ORG_ID,
      AND: [
        {
          OR: [
            { priority: { in: [Priority.High, Priority.Low] } },
            { priority: null },
          ],
        },
      ],
    });
  });

  it("carries only the arm a selection names", async () => {
    expect(await artifactWhereFor([Priority.Urgent])).toEqual({
      organizationId: ORG_ID,
      AND: [{ OR: [{ priority: { in: [Priority.Urgent] } }] }],
    });
    // The unset arm must be `priority: null`, never a member list: `IN (...)`
    // does not match NULL, so folding the token in would select nothing.
    expect(await artifactWhereFor([PRIORITY_UNSET_VALUE])).toEqual({
      organizationId: ORG_ID,
      AND: [{ OR: [{ priority: null }] }],
    });
  });

  it("adds no clause for an absent or empty selection", async () => {
    expect(await artifactWhereFor(undefined)).toEqual({
      organizationId: ORG_ID,
    });
    expect(await artifactWhereFor([])).toEqual({ organizationId: ORG_ID });
  });
});
