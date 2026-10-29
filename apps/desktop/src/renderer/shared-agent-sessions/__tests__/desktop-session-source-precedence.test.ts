import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { AgentSessionListCapability } from "@repo/api/src/types/agent-session-list-contract";
import { ReadSource } from "@repo/api/src/types/read-source";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { describe, expect, it } from "vitest";
import {
  DesktopSessionsListCompleteness,
  DesktopSessionsListFreshness,
  DesktopSessionsListSource,
  DesktopSessionsStableIdentityError,
  getDesktopSessionsListSourceState,
  quarantineInvalidDesktopSessionsRows,
  reconcileDesktopSessionsFallback,
  toDesktopCachedCloudFallbackList,
  toDesktopLocalFallbackList,
  validateDesktopSessionsList,
} from "../desktop-session-source-precedence";

function row(
  id: string,
  externalSessionId: unknown,
  name: string,
  options: { computeTargetId?: string; updatedAt?: Date } = {}
) {
  return createAgentSessionListItemFixture({
    ...(options.computeTargetId
      ? {
          computeTarget: {
            id: options.computeTargetId,
            isOnline: true,
            lastAgentSessionSyncAt: null,
            lastSeenAt: new Date("2026-10-19T12:00:00.000Z"),
            machineName: options.computeTargetId,
          },
        }
      : {}),
    externalSessionId,
    id,
    name,
    tagPermissions: { canApply: true, canRemove: true },
    ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
  });
}

function response(
  items: AgentSessionListResponse["items"],
  total = items.length
): AgentSessionListResponse {
  return {
    items,
    total,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

describe("Desktop Sessions source precedence", () => {
  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["malformed", 42],
  ])(
    "AC-006 DT-SP-07 rejects a %s stable identity at the trust boundary",
    (_label, externalSessionId) => {
      expect(() =>
        validateDesktopSessionsList(
          response([row("row-id", externalSessionId, "Invalid")])
        )
      ).toThrow(DesktopSessionsStableIdentityError);
    }
  );

  it("accepts a valid cloud page that repeats an external id across targets", () => {
    const cloud = response([
      row("cloud-target-a", " shared-id ", "Target A", {
        computeTargetId: "target-a",
      }),
      row("cloud-target-b", "shared-id", "Target B", {
        computeTargetId: "target-b",
      }),
    ]);

    expect(validateDesktopSessionsList(cloud)).toBe(cloud);
  });

  it("rejects a duplicate trimmed identity on the same compute target", () => {
    expect(() =>
      validateDesktopSessionsList(
        response([
          row("first", " shared-id ", "First", {
            computeTargetId: " target-a ",
          }),
          row("second", "shared-id", "Second", {
            computeTargetId: "target-a",
          }),
        ])
      )
    ).toThrow(DesktopSessionsStableIdentityError);
  });

  it("quarantines blank and same-target duplicate rows while retaining valid siblings", () => {
    const result = quarantineInvalidDesktopSessionsRows(
      response([
        row("valid", "external-valid", "Valid"),
        row("blank", " ", "Blank"),
        row("duplicate-a", " shared ", "Duplicate A", {
          computeTargetId: "target-a",
        }),
        row("duplicate-b", "shared", "Duplicate B", {
          computeTargetId: " target-a ",
        }),
        row("cross-target", "shared", "Cross target", {
          computeTargetId: "target-b",
        }),
      ])
    );

    expect(result.response.items.map((item) => item.id)).toEqual([
      "valid",
      "cross-target",
    ]);
    expect(result.issue).toBeInstanceOf(DesktopSessionsStableIdentityError);
  });

  it("reconciles the same external id independently per compute target", () => {
    const result = reconcileDesktopSessionsFallback({
      cachedCloud: response([
        row("cloud-target-a", "shared-id", "Cloud A", {
          computeTargetId: "target-a",
          updatedAt: new Date("2026-10-19T10:00:00.000Z"),
        }),
        row("cloud-target-b", "shared-id", "Cloud B", {
          computeTargetId: "target-b",
        }),
      ]),
      limit: 25,
      local: response([
        row("local-target-a", "shared-id", "Local A", {
          computeTargetId: "target-a",
          updatedAt: new Date("2026-10-19T11:00:00.000Z"),
        }),
      ]),
    });

    expect(result.items.map((item) => item.id)).toEqual([
      "local-target-a",
      "cloud-target-b",
    ]);
  });

  it("AC-003 AC-007 DT-SP-08 DT-SP-09 lets fresh local overlap win while preserving cloud order", () => {
    const cachedCloud = response(
      [
        row("cloud-b", "external-b", "Cloud B"),
        row("cloud-a", "external-a", "Cloud A", {
          updatedAt: new Date("2026-10-19T10:00:00.000Z"),
        }),
      ],
      8
    );
    const local = response(
      [
        row("local-z", "external-z", "Local Z"),
        row("local-a", "external-a", "Local A", {
          updatedAt: new Date("2026-10-19T11:00:00.000Z"),
        }),
        row("local-c", "external-c", "Local C"),
      ],
      11
    );

    const result = reconcileDesktopSessionsFallback({
      cachedCloud,
      limit: 3,
      local,
    });

    expect(result.items.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "cloud-b", name: "Cloud B" },
      { id: "local-a", name: "Local A" },
      { id: "local-z", name: "Local Z" },
    ]);
    expect(result.items.every((item) => item.tagPermissions)).toBe(true);
    expect(getDesktopSessionsListSourceState(result)).toEqual({
      completeness: DesktopSessionsListCompleteness.Partial,
      freshness: DesktopSessionsListFreshness.Stale,
      hasKnownTotal: false,
      source: DesktopSessionsListSource.Mixed,
    });
  });

  it("keeps a fresher cloud row when local overlap is older", () => {
    const result = reconcileDesktopSessionsFallback({
      cachedCloud: response([
        row("cloud", "external", "Cloud fresh", {
          updatedAt: new Date("2026-10-19T12:00:00.000Z"),
        }),
      ]),
      limit: 25,
      local: response([
        row("local", "external", "Local stale", {
          updatedAt: new Date("2026-10-19T11:00:00.000Z"),
        }),
      ]),
    });

    expect(result.items[0]?.id).toBe("cloud");
  });

  it("keeps cloud on an equal-freshness overlap", () => {
    const updatedAt = new Date("2026-10-19T12:00:00.000Z");
    const result = reconcileDesktopSessionsFallback({
      cachedCloud: response([row("cloud", "external", "Cloud", { updatedAt })]),
      limit: 25,
      local: response([row("local", "external", "Local", { updatedAt })]),
    });

    expect(result.items[0]?.id).toBe("cloud");
  });

  it("AC-007 DT-SP-09 preserves local producer order for filler rows", () => {
    const cachedCloud = response([row("cloud", "external-m", "Cloud")], 5);
    const localRows = [
      row("local-z", "external-z", "Local Z"),
      row("local-a", "external-a", "Local A"),
    ];
    const reconcile = (items: typeof localRows) =>
      reconcileDesktopSessionsFallback({
        cachedCloud,
        limit: 2,
        local: response(items, 7),
      }).items.map((item) => item.externalSessionId);

    expect(reconcile(localRows)).toEqual(["external-m", "external-z"]);
    expect(reconcile([...localRows].reverse())).toEqual([
      "external-m",
      "external-a",
    ]);
  });

  it("AC-007 DT-SP-10 marks a disjoint mixed population total unknown", () => {
    const result = reconcileDesktopSessionsFallback({
      cachedCloud: response([row("cloud", "external-cloud", "Cloud")], 1),
      limit: 25,
      local: response([row("local", "external-local", "Local")], 1),
    });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(getDesktopSessionsListSourceState(result)?.completeness).toBe(
      DesktopSessionsListCompleteness.Partial
    );
    expect(getDesktopSessionsListSourceState(result)?.hasKnownTotal).toBe(
      false
    );
  });

  it("AC-002 AC-004 DT-SP-03 DT-SP-05 keeps local fresh and cached cloud stale without dropping operands", () => {
    const list = response([row("row", "external-row", "Row")], 1);
    const local = toDesktopLocalFallbackList(list);
    const cached = toDesktopCachedCloudFallbackList({
      ...list,
      readSource: ReadSource.Cloud,
    });

    expect(local.readSource).toBe(ReadSource.Local);
    expect(local.items[0]?.tagPermissions).toEqual({
      canApply: true,
      canRemove: true,
    });
    expect(getDesktopSessionsListSourceState(local)).toMatchObject({
      freshness: DesktopSessionsListFreshness.Fresh,
      source: DesktopSessionsListSource.Local,
    });
    expect(cached.readSource).toBe(ReadSource.Cloud);
    expect(cached.items[0]?.tagPermissions).toEqual({
      canApply: true,
      canRemove: true,
    });
    expect(getDesktopSessionsListSourceState(cached)).toMatchObject({
      freshness: DesktopSessionsListFreshness.Stale,
      source: DesktopSessionsListSource.CachedCloud,
    });
  });

  it("preserves local pagination evidence so rows after 25 remain reachable", () => {
    const firstPage = toDesktopLocalFallbackList({
      ...response(
        Array.from({ length: 25 }, (_, index) =>
          row(
            `local-${index + 1}`,
            `external-${index + 1}`,
            `Local ${index + 1}`
          )
        ),
        51
      ),
      pageInfo: {
        capability: AgentSessionListCapability.ServerPaginationV1,
        limit: 25,
        offset: 0,
      },
    });
    const secondPage = toDesktopLocalFallbackList({
      ...response([row("local-26", "external-26", "Local 26")], 51),
      pageInfo: {
        capability: AgentSessionListCapability.ServerPaginationV1,
        limit: 25,
        offset: 25,
      },
    });

    expect(firstPage).toMatchObject({ total: 51, pageInfo: { offset: 0 } });
    expect(secondPage).toMatchObject({
      items: [{ id: "local-26" }],
      pageInfo: { limit: 25, offset: 25 },
      total: 51,
    });
    expect(getDesktopSessionsListSourceState(secondPage)?.hasKnownTotal).toBe(
      true
    );
  });

  it("preserves cached-cloud and mixed pagination evidence for later pages", () => {
    const pageInfo = {
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: 25,
      offset: 25,
    } as const;
    const cached = toDesktopCachedCloudFallbackList({
      ...response([row("cloud-26", "external-cloud-26", "Cloud 26")], 51),
      pageInfo,
    });
    const mixed = reconcileDesktopSessionsFallback({
      cachedCloud: cached,
      limit: 25,
      local: {
        ...response(
          [
            row("local-26", "external-cloud-26", "Local 26", {
              updatedAt: new Date("2026-10-19T13:00:00.000Z"),
            }),
          ],
          49
        ),
        pageInfo,
      },
    });

    for (const page of [cached, mixed]) {
      expect(page).toMatchObject({ pageInfo: { offset: 25 }, total: 51 });
      expect(getDesktopSessionsListSourceState(page)?.hasKnownTotal).toBe(true);
      expect(getDesktopSessionsListSourceState(page)?.completeness).toBe(
        DesktopSessionsListCompleteness.Partial
      );
    }
    expect(mixed.items.map((item) => item.id)).toEqual(["local-26"]);
  });
});
