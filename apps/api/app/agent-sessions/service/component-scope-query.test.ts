import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentSessionListQuerySchema,
  agentSessionUsageQuerySchema,
} from "../validators";
import { buildWhere } from "./query-builder";
import { buildUsageSummaryWhere } from "./usage-summary-where";

const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("../../agent-components/service/component-session-scope", () => ({
  buildComponentSessionScope: mocks.scope,
}));

const organizationId = "11111111-1111-7111-8111-111111111111";
const componentSlug = "subagent::design-critic";
const componentWhere = {
  componentUsages: { some: { componentKeyNormalized: "design-critic" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue(componentWhere);
});

describe("component-scoped session query composition", () => {
  it("keeps list facets and tenant scope conjunctive with the canonical component cohort", async () => {
    const where = await buildWhere(
      { organizationId },
      agentSessionListQuerySchema.parse({
        componentSlug,
        statuses: SESSION_STATUS.INACTIVE,
      })
    );
    expect(mocks.scope).toHaveBeenCalledWith(organizationId, componentSlug);
    expect(where).toMatchObject({
      AND: [
        {
          artifact: {
            is: { organizationId, status: SESSION_STATUS.INACTIVE },
          },
        },
        componentWhere,
      ],
    });
  });

  it("uses that same component cohort for usage reads", async () => {
    const where = await buildUsageSummaryWhere({
      organizationId,
      filters: agentSessionUsageQuerySchema.parse({ componentSlug }),
    });
    expect(mocks.scope).toHaveBeenCalledWith(organizationId, componentSlug);
    expect(where).toMatchObject({
      AND: [{ artifact: { is: { organizationId } } }, componentWhere],
    });
  });

  it("leaves older unscoped requests unchanged", async () => {
    const where = await buildWhere(
      { organizationId },
      agentSessionListQuerySchema.parse({})
    );
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(where).toMatchObject({ artifact: { is: { organizationId } } });
    expect(where.AND).toBeUndefined();
  });

  it("propagates a failed scope read rather than widening to the organization", async () => {
    mocks.scope.mockRejectedValue(new Error("scope unavailable"));
    await expect(
      buildWhere(
        { organizationId },
        agentSessionListQuerySchema.parse({ componentSlug })
      )
    ).rejects.toThrow("scope unavailable");
  });

  it.each(["", "  ", "x".repeat(4097)])(
    "rejects an invalid scope at the request boundary",
    (value) => {
      expect(
        agentSessionListQuerySchema.safeParse({ componentSlug: value }).success
      ).toBe(false);
      expect(
        agentSessionUsageQuerySchema.safeParse({ componentSlug: value }).success
      ).toBe(false);
    }
  );
});
