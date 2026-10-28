import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { AgentSessionListCapability } from "@repo/api/src/types/agent-session-list-contract";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import type {
  AgentSessionCapabilities,
  AgentSessionQueryFilters,
  AgentSessionsDataSource,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopCloudPrimaryAgentSessionsDataSource,
  DESKTOP_CLOUD_PRIMARY_SESSIONS_SCOPE_PREFIX,
} from "../desktop-agent-sessions-data-source";
import {
  DesktopSessionsListCompleteness,
  DesktopSessionsListFreshness,
  DesktopSessionsListSource,
  DesktopSessionsStableIdentityError,
  getDesktopSessionsListSourceState,
} from "../desktop-session-source-precedence";

const DEFAULT_FILTERS = {
  limit: 25,
  offset: 0,
} satisfies AgentSessionQueryFilters;

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

function source(
  scope: string,
  overrides: Partial<AgentSessionsDataSource> = {}
): AgentSessionsDataSource {
  const empty = response([]);
  return {
    scope,
    list: vi.fn(async () => empty),
    detail: vi.fn(() => Promise.reject(new Error(`${scope} detail`))),
    usage: vi.fn(() => Promise.reject(new Error(`${scope} usage`))),
    analytics: vi.fn(() => Promise.reject(new Error(`${scope} analytics`))),
    pageData: vi.fn(async () => ({ list: empty })),
    ...overrides,
  };
}

function adapter(
  cloudSource: AgentSessionsDataSource,
  localSource: AgentSessionsDataSource,
  identity = { organizationId: "org-1", userId: "user-1" },
  reportCloudReadFailure?: (error: Error) => void
) {
  return createDesktopCloudPrimaryAgentSessionsDataSource({
    cloudSource,
    identity,
    localSource,
    reportCloudReadFailure,
  });
}

describe("Desktop cloud-primary Sessions data source", () => {
  it("AC-001 DT-SP-01 DT-SP-02 treats cloud success, including empty, as authoritative", async () => {
    const cloudList = vi.fn(async () => response([]));
    const localList = vi.fn(async () =>
      response([row("local", "external-local", "Local")])
    );
    const dataSource = adapter(
      source("cloud", { list: cloudList }),
      source("local", { list: localList })
    );

    const result = await dataSource.list(DEFAULT_FILTERS);

    expect(result.items).toEqual([]);
    expect(localList).not.toHaveBeenCalled();
    expect(getDesktopSessionsListSourceState(result)).toEqual({
      completeness: DesktopSessionsListCompleteness.Complete,
      freshness: DesktopSessionsListFreshness.Fresh,
      hasKnownTotal: true,
      source: DesktopSessionsListSource.Cloud,
    });
    expect(dataSource.scope).toMatch(
      new RegExp(`^${DESKTOP_CLOUD_PRIMARY_SESSIONS_SCOPE_PREFIX}:`)
    );
  });

  it("keeps a valid cross-target cloud page authoritative when external ids repeat", async () => {
    const cloudResponse = response([
      row("target-a", "shared-external-id", "Target A", {
        computeTargetId: "target-a",
      }),
      row("target-b", "shared-external-id", "Target B", {
        computeTargetId: "target-b",
      }),
    ]);
    const localList = vi.fn(async () => response([]));
    const dataSource = adapter(
      source("cloud", { list: vi.fn(async () => cloudResponse) }),
      source("local", { list: localList })
    );

    await expect(dataSource.list(DEFAULT_FILTERS)).resolves.toBe(cloudResponse);
    expect(localList).not.toHaveBeenCalled();
  });

  it("quarantines fresh same-target duplicates and retains valid cloud siblings", async () => {
    const duplicateCloud = response([
      row("valid", "external-valid", "Valid", {
        computeTargetId: "target-b",
      }),
      row("first", " shared-external-id ", "First", {
        computeTargetId: " target-a ",
      }),
      row("second", "shared-external-id", "Second", {
        computeTargetId: "target-a",
      }),
    ]);
    const localList = vi.fn(async () => response([]));
    const reportReadFailure = vi.fn();
    const dataSource = adapter(
      source("cloud", { list: vi.fn(async () => duplicateCloud) }),
      source("local", { list: localList }),
      undefined,
      reportReadFailure
    );

    await expect(dataSource.list(DEFAULT_FILTERS)).resolves.toMatchObject({
      items: [{ id: "valid" }],
    });
    expect(localList).not.toHaveBeenCalled();
    expect(reportReadFailure).toHaveBeenCalledWith(
      expect.any(DesktopSessionsStableIdentityError)
    );
  });

  it("quarantines a cached same-target duplicate while retaining valid cached evidence", async () => {
    const cached = response([
      row("valid", "external-valid", "Valid", {
        computeTargetId: "target-b",
      }),
      row("target-a", "shared-external-id", "Target A", {
        computeTargetId: "target-a",
      }),
    ]);
    const cloudList = vi
      .fn<AgentSessionsDataSource["list"]>()
      .mockResolvedValueOnce(cached)
      .mockRejectedValueOnce(new Error("cloud unavailable"));
    const localList = vi.fn(async () =>
      response([row("local", "shared-external-id", "Local")])
    );
    const reportReadFailure = vi.fn();
    const dataSource = adapter(
      source("cloud", { list: cloudList }),
      source("local", {
        list: localList,
      }),
      undefined,
      reportReadFailure
    );

    await dataSource.list(DEFAULT_FILTERS);
    cached.items.push(
      row("target-a-duplicate", "shared-external-id", "Target A duplicate", {
        computeTargetId: "target-a",
      })
    );

    await expect(dataSource.list(DEFAULT_FILTERS)).resolves.toMatchObject({
      items: [{ id: "valid" }, { id: "local" }],
    });
    expect(reportReadFailure).toHaveBeenCalledWith(
      expect.any(DesktopSessionsStableIdentityError)
    );
    expect(localList).toHaveBeenCalled();
  });

  it("AC-002 DT-SP-03 falls back to fresh partial local rows after an initial cloud failure", async () => {
    const cloudError = new Error("cloud unavailable");
    const reportCloudReadFailure = vi.fn();
    const localList = vi.fn(async () =>
      response([row("local", "external-local", "Local")], 9)
    );
    const dataSource = adapter(
      source("cloud", {
        list: vi.fn(() => Promise.reject(cloudError)),
      }),
      source("local", { list: localList }),
      undefined,
      reportCloudReadFailure
    );

    const result = await dataSource.list(DEFAULT_FILTERS);

    expect(result.items.map((item) => item.id)).toEqual(["local"]);
    expect(result.items[0]?.tagPermissions).toEqual({
      canApply: true,
      canRemove: true,
    });
    expect(reportCloudReadFailure).toHaveBeenCalledWith(cloudError);
    expect(getDesktopSessionsListSourceState(result)).toMatchObject({
      completeness: DesktopSessionsListCompleteness.Partial,
      freshness: DesktopSessionsListFreshness.Fresh,
      hasKnownTotal: true,
      source: DesktopSessionsListSource.Local,
    });
  });

  it("serves every requested local fallback page with the producer's known total", async () => {
    const localRows = Array.from({ length: 51 }, (_, index) =>
      row(`local-${index}`, `external-${index}`, `Local ${index}`)
    );
    const localList = vi.fn<AgentSessionsDataSource["list"]>(async (filters) =>
      response(
        localRows.slice(filters.offset ?? 0, (filters.offset ?? 0) + 25),
        localRows.length
      )
    );
    const dataSource = adapter(
      source("cloud", {
        list: vi.fn(() => Promise.reject(new Error("cloud unavailable"))),
      }),
      source("local", { list: localList })
    );

    const first = await dataSource.list({ limit: 25, offset: 0 });
    const second = await dataSource.list({ limit: 25, offset: 25 });
    const third = await dataSource.list({ limit: 25, offset: 50 });

    expect(first.items).toHaveLength(25);
    expect(second.items).toHaveLength(25);
    expect(second.items[0]?.id).toBe("local-25");
    expect(third.items.map((item) => item.id)).toEqual(["local-50"]);
    for (const page of [first, second, third]) {
      expect(getDesktopSessionsListSourceState(page)?.completeness).toBe(
        DesktopSessionsListCompleteness.Partial
      );
      expect(getDesktopSessionsListSourceState(page)?.hasKnownTotal).toBe(true);
    }
  });

  it("AC-003 DT-SP-04 DT-SP-08 preserves cached cloud and lets fresher local overlap win", async () => {
    const cloudList = vi
      .fn<AgentSessionsDataSource["list"]>()
      .mockResolvedValueOnce(
        response(
          [
            row("cloud-only", "external-cloud", "Cloud only"),
            row("cloud-overlap", "external-shared", "Cloud stale", {
              updatedAt: new Date("2026-10-19T10:00:00.000Z"),
            }),
          ],
          12
        )
      )
      .mockRejectedValue(new Error("cloud refresh failed"));
    const localList = vi.fn(async () =>
      response(
        [
          row("local-overlap", "external-shared", "Local fresh", {
            updatedAt: new Date("2026-10-19T11:00:00.000Z"),
          }),
          row("local-only", "external-local", "Local only"),
        ],
        7
      )
    );
    const cloudCapabilities: AgentSessionCapabilities = {
      [AgentSessionCapability.ActivityPage]: false,
      [AgentSessionCapability.Collaborators]: false,
      [AgentSessionCapability.CustomFieldValues]: false,
      [AgentSessionCapability.EventsPage]: false,
      [AgentSessionCapability.LinkedArtifacts]: true,
      [AgentSessionCapability.Rename]: false,
      [AgentSessionCapability.SessionInvocationTree]: false,
      [AgentSessionCapability.UpdatePriority]: false,
    };
    const cloud = source("cloud", {
      capabilitiesForSession: () => cloudCapabilities,
      list: cloudList,
    });
    const local = source("local", { list: localList });
    const dataSource = adapter(cloud, local);

    await dataSource.list(DEFAULT_FILTERS);
    const result = await dataSource.list(DEFAULT_FILTERS);

    expect(result.items.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "cloud-only", name: "Cloud only" },
      { id: "local-overlap", name: "Local fresh" },
      { id: "local-only", name: "Local only" },
    ]);
    expect(result.total).toBe(12);
    expect(getDesktopSessionsListSourceState(result)).toMatchObject({
      completeness: DesktopSessionsListCompleteness.Partial,
      freshness: DesktopSessionsListFreshness.Stale,
      source: DesktopSessionsListSource.Mixed,
    });
    expect(
      agentSessionSourceSupports(
        dataSource,
        "local-overlap",
        AgentSessionCapability.LinkedArtifacts
      )
    ).toBe(false);
    expect(
      agentSessionSourceSupports(
        dataSource,
        "cloud-only",
        AgentSessionCapability.LinkedArtifacts
      )
    ).toBe(true);
    const retried = await dataSource.list(DEFAULT_FILTERS);
    expect(retried.items.map((item) => item.id)).toEqual([
      "cloud-only",
      "local-overlap",
      "local-only",
    ]);
  });

  it("AC-004 DT-SP-05 keeps cached cloud evidence when the refresh and local fallback fail", async () => {
    const cached = response([row("cached", "external-cached", "Cached")], 4);
    const cloudList = vi
      .fn<AgentSessionsDataSource["list"]>()
      .mockResolvedValueOnce(cached)
      .mockRejectedValueOnce(new Error("cloud refresh failed"));
    const localList = vi.fn(() => Promise.reject(new Error("local failed")));
    const dataSource = adapter(
      source("cloud", { list: cloudList }),
      source("local", { list: localList })
    );

    await dataSource.list(DEFAULT_FILTERS);
    const result = await dataSource.list(DEFAULT_FILTERS);

    expect(result.items.map((item) => item.id)).toEqual(["cached"]);
    expect(getDesktopSessionsListSourceState(result)).toMatchObject({
      completeness: DesktopSessionsListCompleteness.Partial,
      freshness: DesktopSessionsListFreshness.Stale,
      source: DesktopSessionsListSource.CachedCloud,
    });
  });

  it("AC-005 DT-SP-06 returns the cloud error when both sources fail without cached evidence", async () => {
    const cloudError = new Error("cloud failed");
    const dataSource = adapter(
      source("cloud", {
        list: vi.fn(() => Promise.reject(cloudError)),
      }),
      source("local", {
        list: vi.fn(() => Promise.reject(new Error("local failed"))),
      })
    );

    await expect(dataSource.list(DEFAULT_FILTERS)).rejects.toBe(cloudError);
  });

  it.each([401, 403])(
    "rethrows a %s cloud response without reading local fallback",
    async (status) => {
      const cloudError = new ApiError("authorization failed", status);
      const localList = vi.fn(async () => response([]));
      const reportCloudReadFailure = vi.fn();
      const dataSource = adapter(
        source("cloud", { list: vi.fn(() => Promise.reject(cloudError)) }),
        source("local", { list: localList }),
        undefined,
        reportCloudReadFailure
      );

      await expect(dataSource.list(DEFAULT_FILTERS)).rejects.toBe(cloudError);
      expect(localList).not.toHaveBeenCalled();
      expect(reportCloudReadFailure).not.toHaveBeenCalled();
    }
  );

  it.each([401, 403])(
    "rethrows a %s cloud detail response without outage reporting",
    async (status) => {
      const cloudError = new ApiError("authorization failed", status);
      const reportCloudReadFailure = vi.fn();
      const dataSource = adapter(
        source("cloud", {
          detail: vi.fn(() => Promise.reject(cloudError)),
        }),
        source("local"),
        undefined,
        reportCloudReadFailure
      );

      await expect(dataSource.detail("cloud-id")).rejects.toBe(cloudError);
      expect(reportCloudReadFailure).not.toHaveBeenCalled();
    }
  );

  it.each([401, 403])(
    "rethrows a %s cloud page-data response without reading local fallback",
    async (status) => {
      const cloudError = new ApiError("authorization failed", status);
      const localList = vi.fn(async () => response([]));
      const reportCloudReadFailure = vi.fn();
      const dataSource = adapter(
        source("cloud", {
          pageData: vi.fn(() => Promise.reject(cloudError)),
        }),
        source("local", { list: localList }),
        undefined,
        reportCloudReadFailure
      );

      await expect(dataSource.pageData(DEFAULT_FILTERS)).rejects.toBe(
        cloudError
      );
      expect(localList).not.toHaveBeenCalled();
      expect(reportCloudReadFailure).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null])(
    "rejects a %s compute-target parent before consulting local fallback",
    async (computeTarget) => {
      const malformedItem = row("invalid", "external-invalid", "Invalid");
      Object.defineProperty(malformedItem, "computeTarget", {
        configurable: true,
        value: computeTarget,
      });
      const localList = vi.fn(async () => response([]));
      const dataSource = adapter(
        source("cloud", {
          list: vi.fn(async () => response([malformedItem])),
        }),
        source("local", { list: localList })
      );

      await expect(dataSource.list(DEFAULT_FILTERS)).rejects.toBeInstanceOf(
        DesktopSessionsStableIdentityError
      );
      expect(localList).not.toHaveBeenCalled();
    }
  );

  it("AC-006 DT-SP-07 rejects an all-malformed page without selecting an unsafe fallback", async () => {
    const validLocal = response([
      row("local", "external-local", "Valid local"),
    ]);
    const malformed = response([row("invalid", " ", "Invalid")]);
    const reportRecoverableFailure = vi.fn();
    const recoverableLocalList = vi.fn(async () => validLocal);
    const recoverable = adapter(
      source("cloud", { list: vi.fn(async () => malformed) }),
      source("local", { list: recoverableLocalList }),
      undefined,
      reportRecoverableFailure
    );
    const reportUnusableFailure = vi.fn();
    const unusable = adapter(
      source("cloud", {
        list: vi.fn(() => Promise.reject(new Error("cloud failed"))),
      }),
      source("local", { list: vi.fn(async () => malformed) }),
      undefined,
      reportUnusableFailure
    );

    await expect(recoverable.list(DEFAULT_FILTERS)).rejects.toBeInstanceOf(
      DesktopSessionsStableIdentityError
    );
    await expect(unusable.list(DEFAULT_FILTERS)).rejects.toBeInstanceOf(
      DesktopSessionsStableIdentityError
    );
    expect(reportRecoverableFailure).toHaveBeenCalledWith(
      expect.any(DesktopSessionsStableIdentityError)
    );
    expect(recoverableLocalList).not.toHaveBeenCalled();
    expect(reportUnusableFailure).toHaveBeenCalledWith(
      expect.any(DesktopSessionsStableIdentityError)
    );
  });

  it("reports and quarantines a malformed cloud row while preserving valid authoritative rows", async () => {
    const reportReadFailure = vi.fn();
    const localList = vi.fn(async () => response([]));
    const dataSource = adapter(
      source("cloud", {
        list: vi.fn(async () =>
          response([
            row("valid", "external-valid", "Valid"),
            row("invalid", " ", "Invalid"),
          ])
        ),
      }),
      source("local", { list: localList }),
      undefined,
      reportReadFailure
    );

    const result = await dataSource.list(DEFAULT_FILTERS);

    expect(result.items.map((item) => item.id)).toEqual(["valid"]);
    expect(localList).not.toHaveBeenCalled();
    expect(reportReadFailure).toHaveBeenCalledTimes(1);
    expect(reportReadFailure).toHaveBeenCalledWith(
      expect.any(DesktopSessionsStableIdentityError)
    );
    expect(getDesktopSessionsListSourceState(result)).toMatchObject({
      completeness: DesktopSessionsListCompleteness.Partial,
      freshness: DesktopSessionsListFreshness.Fresh,
      hasKnownTotal: true,
      source: DesktopSessionsListSource.Cloud,
    });
  });

  it("quarantines malformed pageData siblings without consulting local fallback", async () => {
    const reportReadFailure = vi.fn();
    const localList = vi.fn(async () => response([]));
    const cloudPageData = vi.fn(async () => ({
      list: response([
        row("valid", "external-valid", "Valid"),
        row("invalid", " ", "Invalid"),
      ]),
      usageError: true,
    }));
    const dataSource = adapter(
      source("cloud", { pageData: cloudPageData }),
      source("local", { list: localList }),
      undefined,
      reportReadFailure
    );

    const result = await dataSource.pageData(DEFAULT_FILTERS);

    expect(result).toMatchObject({
      list: { items: [{ id: "valid" }] },
      usageError: true,
    });
    expect(localList).not.toHaveBeenCalled();
    expect(reportReadFailure).toHaveBeenCalledTimes(1);
    expect(reportReadFailure).toHaveBeenCalledWith(
      expect.any(DesktopSessionsStableIdentityError)
    );
    expect(getDesktopSessionsListSourceState(result.list)).toMatchObject({
      completeness: DesktopSessionsListCompleteness.Partial,
      freshness: DesktopSessionsListFreshness.Fresh,
      source: DesktopSessionsListSource.Cloud,
    });
  });

  it("keeps the last fully valid pageData cache after a quarantined partial response", async () => {
    const cloudPageData = vi
      .fn<AgentSessionsDataSource["pageData"]>()
      .mockResolvedValueOnce({
        list: response([row("cached", "external-cached", "Cached")]),
      })
      .mockResolvedValueOnce({
        list: response([
          row("partial", "external-partial", "Partial"),
          row("invalid", " ", "Invalid"),
        ]),
      })
      .mockRejectedValueOnce(new Error("cloud page failed"));
    const localList = vi.fn(() => Promise.reject(new Error("local failed")));
    const reportReadFailure = vi.fn();
    const dataSource = adapter(
      source("cloud", { pageData: cloudPageData }),
      source("local", { list: localList }),
      undefined,
      reportReadFailure
    );

    const valid = await dataSource.pageData(DEFAULT_FILTERS);
    const partial = await dataSource.pageData(DEFAULT_FILTERS);
    const fallback = await dataSource.pageData(DEFAULT_FILTERS);

    expect(valid.list.items.map((item) => item.id)).toEqual(["cached"]);
    expect(partial.list.items.map((item) => item.id)).toEqual(["partial"]);
    expect(getDesktopSessionsListSourceState(partial.list)).toMatchObject({
      completeness: DesktopSessionsListCompleteness.Partial,
      freshness: DesktopSessionsListFreshness.Fresh,
      source: DesktopSessionsListSource.Cloud,
    });
    expect(fallback.list.items.map((item) => item.id)).toEqual(["cached"]);
    expect(fallback.usageError).toBe(true);
    expect(getDesktopSessionsListSourceState(fallback.list)).toMatchObject({
      freshness: DesktopSessionsListFreshness.Stale,
      source: DesktopSessionsListSource.CachedCloud,
    });
    expect(localList).toHaveBeenCalledTimes(1);
    expect(reportReadFailure).toHaveBeenCalledWith(
      expect.any(DesktopSessionsStableIdentityError)
    );
  });

  it("does not replace the last fully valid cache with a quarantined partial read", async () => {
    const cloudList = vi
      .fn<AgentSessionsDataSource["list"]>()
      .mockResolvedValueOnce(
        response([row("cached", "external-cached", "Cached")])
      )
      .mockResolvedValueOnce(
        response([
          row("partial", "external-partial", "Partial"),
          row("invalid", " ", "Invalid"),
        ])
      )
      .mockRejectedValueOnce(new Error("cloud unavailable"));
    const localList = vi.fn(() => Promise.reject(new Error("local failed")));
    const reportReadFailure = vi.fn();
    const dataSource = adapter(
      source("cloud", { list: cloudList }),
      source("local", { list: localList }),
      undefined,
      reportReadFailure
    );

    await dataSource.list(DEFAULT_FILTERS);
    const partial = await dataSource.list(DEFAULT_FILTERS);
    const fallback = await dataSource.list(DEFAULT_FILTERS);

    expect(partial.items.map((item) => item.id)).toEqual(["partial"]);
    expect(getDesktopSessionsListSourceState(partial)).toMatchObject({
      completeness: DesktopSessionsListCompleteness.Partial,
      freshness: DesktopSessionsListFreshness.Fresh,
      source: DesktopSessionsListSource.Cloud,
    });
    expect(fallback.items.map((item) => item.id)).toEqual(["cached"]);
    expect(getDesktopSessionsListSourceState(fallback)).toMatchObject({
      freshness: DesktopSessionsListFreshness.Stale,
      source: DesktopSessionsListSource.CachedCloud,
    });
    expect(localList).toHaveBeenCalledTimes(1);
    expect(reportReadFailure).toHaveBeenCalledWith(
      expect.any(DesktopSessionsStableIdentityError)
    );
  });

  it("keeps cached-cloud and mixed later pages reachable from their known total", async () => {
    const pageFilters = { limit: 25, offset: 25 };
    const pageInfo = {
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: 25,
      offset: 25,
    };
    const cachedPage = {
      ...response([row("cloud-26", "external-cloud-26", "Cloud 26")], 51),
      pageInfo,
    };
    const cloudList = vi
      .fn<AgentSessionsDataSource["list"]>()
      .mockResolvedValueOnce(cachedPage)
      .mockRejectedValue(new Error("cloud refresh failed"));
    const localList = vi
      .fn<AgentSessionsDataSource["list"]>()
      .mockResolvedValueOnce({
        ...response(
          [
            row("local-26", "external-cloud-26", "Local 26", {
              updatedAt: new Date("2026-10-19T13:00:00.000Z"),
            }),
          ],
          49
        ),
        pageInfo,
      })
      .mockRejectedValueOnce(new Error("local failed"));
    const dataSource = adapter(
      source("cloud", { list: cloudList }),
      source("local", { list: localList })
    );

    await dataSource.list(pageFilters);
    const mixed = await dataSource.list(pageFilters);
    const cachedOnly = await dataSource.list(pageFilters);

    for (const page of [mixed, cachedOnly]) {
      expect(page).toMatchObject({ pageInfo: { offset: 25 }, total: 51 });
      expect(getDesktopSessionsListSourceState(page)?.hasKnownTotal).toBe(true);
      expect(getDesktopSessionsListSourceState(page)?.completeness).toBe(
        DesktopSessionsListCompleteness.Partial
      );
    }
    expect(mixed.items.map((item) => item.id)).toEqual(["local-26"]);
  });

  it("AC-009 DT-SP-14 DT-SP-15 isolates last-good data by normalized filter scope", async () => {
    const cloudError = new Error("cloud failed for requested scope");
    const cloudList = vi
      .fn<AgentSessionsDataSource["list"]>()
      .mockResolvedValueOnce(
        response([row("cached", "external-cached", "Cached")])
      )
      .mockRejectedValue(cloudError);
    const localList = vi.fn(() => Promise.reject(new Error("local failed")));
    const dataSource = adapter(
      source("cloud", { list: cloudList }),
      source("local", { list: localList })
    );
    const firstScope = { ...DEFAULT_FILTERS, search: "first" };

    await dataSource.list(firstScope);
    await expect(
      dataSource.list({ ...DEFAULT_FILTERS, search: "second" })
    ).rejects.toBe(cloudError);
    await expect(dataSource.list(firstScope)).resolves.toMatchObject({
      items: [{ id: "cached" }],
    });
  });

  it("AC-009 DT-SP-15 forwards one abort boundary and does not start local fallback after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const cloudList = vi.fn(() => Promise.reject(new Error("cloud failed")));
    const localList = vi.fn(async () => response([]));
    const dataSource = adapter(
      source("cloud", { list: cloudList }),
      source("local", { list: localList })
    );

    await expect(
      dataSource.list(DEFAULT_FILTERS, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cloudList).toHaveBeenCalledWith(DEFAULT_FILTERS, {
      signal: controller.signal,
    });
    expect(localList).not.toHaveBeenCalled();
  });

  it("AC-008 DT-SP-11 routes by row without letting a local detail change cloud list capabilities", async () => {
    const renameSession = vi.fn(async () => undefined);
    const cloud = source("cloud", { renameSession });
    const local = source("local");
    const cloudList = vi
      .mocked(cloud.list)
      .mockResolvedValueOnce(
        response([row("cloud-id", "external-cloud", "Cloud")])
      )
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce(
        response([row("cloud-id", "external-cloud", "Cloud refreshed")])
      );
    vi.mocked(local.list).mockResolvedValueOnce(
      response([row("local-id", "external-local", "Local")])
    );
    const dataSource = adapter(cloud, local);

    await dataSource.list(DEFAULT_FILTERS);
    await dataSource.list(DEFAULT_FILTERS);
    await expect(dataSource.detail("local-id")).rejects.toThrow("local detail");
    await dataSource.list(DEFAULT_FILTERS);
    expect(dataSource.renameSession).toBeTypeOf("function");
    await dataSource.renameSession?.("cloud-id", { name: "Cloud renamed" });
    expect(renameSession).toHaveBeenCalledWith("cloud-id", {
      name: "Cloud renamed",
    });
    expect(cloudList).toHaveBeenCalledTimes(3);
  });

  it("AC-002 AC-010 DT-SP-03 DT-SP-16 applies fallback through the production pageData caller", async () => {
    const cloud = source("cloud", {
      pageData: vi.fn(() => Promise.reject(new Error("cloud page failed"))),
    });
    const local = source("local", {
      list: vi.fn(async () =>
        response([row("local", "external-local", "Local")])
      ),
    });

    const result = await adapter(cloud, local).pageData(DEFAULT_FILTERS);

    expect(result.usageError).toBe(true);
    expect(result.list.items.map((item) => item.id)).toEqual(["local"]);
    expect(getDesktopSessionsListSourceState(result.list)?.source).toBe(
      DesktopSessionsListSource.Local
    );
  });
});
