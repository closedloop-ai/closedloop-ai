import { describe, expect, it } from "vitest";
import {
  AgentSessionListCapability,
  type CanonicalAgentSessionListItem,
} from "../agent-session-list-contract.ts";
import { resolveListQueryCapability } from "../list-query-capability.ts";
import {
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  type ListQueryExpression,
  ListQueryRefusal,
} from "../list-query-expression.ts";
import { SessionListField } from "../list-query-fields.ts";
import {
  CLOUD_SESSION_LIST_QUERY_CAPABILITY,
  DESKTOP_SESSION_LIST_QUERY_CAPABILITY,
} from "../session-list-query-capabilities.ts";
import {
  DISPLAYED_SESSION_STATUS,
  resolveDisplayedSessionStatus,
  SESSION_STATUS,
} from "../session-status.ts";

describe("ISS-9524 canonical Sessions list contract", () => {
  it("keeps raw version-skew evidence distinct from the three-value displayed row status", () => {
    const row = {
      id: "session-one",
      externalSessionId: "external-one",
      rawStatus: "waiting",
      status: resolveDisplayedSessionStatus({ status: "waiting" }),
    } satisfies Pick<
      CanonicalAgentSessionListItem,
      "id" | "externalSessionId" | "rawStatus" | "status"
    >;

    expect(Object.values(DISPLAYED_SESSION_STATUS).sort()).toEqual([
      SESSION_STATUS.ACTIVE,
      SESSION_STATUS.ERROR,
      SESSION_STATUS.INACTIVE,
    ]);
    expect(row.rawStatus).toBe("waiting");
    expect(row.status).toBe(SESSION_STATUS.ACTIVE);
    expect(resolveDisplayedSessionStatus({ status: "future-status" })).toBe(
      SESSION_STATUS.ACTIVE
    );
  });

  it("declares pagination and refuses Desktop-only capability gaps without widening a query", () => {
    expect(AgentSessionListCapability.ServerPaginationV1).toBe(
      "server_pagination_v1"
    );
    const projectFilter = {
      version: LIST_QUERY_EXPRESSION_VERSION,
      filters: [
        {
          field: SessionListField.ProjectIds,
          operator: ListFilterOperator.IsAnyOf,
          values: ["01a07463-31f5-773e-9fa9-bd1dbdac9f1b"],
        },
      ],
    } satisfies ListQueryExpression;
    expect(
      resolveListQueryCapability(
        projectFilter,
        CLOUD_SESSION_LIST_QUERY_CAPABILITY
      )
    ).toEqual({ ok: true });
    expect(
      resolveListQueryCapability(
        projectFilter,
        DESKTOP_SESSION_LIST_QUERY_CAPABILITY
      )
    ).toEqual({
      ok: false,
      refused: {
        code: ListQueryRefusal.UnsupportedField,
        details: { field: SessionListField.ProjectIds },
      },
    });
  });
});
