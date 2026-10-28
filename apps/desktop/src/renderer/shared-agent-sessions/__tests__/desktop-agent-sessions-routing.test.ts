import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import type {
  AgentSessionQueryFilters,
  AgentSessionsDataSource,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { describe, expect, it, vi } from "vitest";
import { createDesktopCloudPrimaryAgentSessionsDataSource } from "../desktop-agent-sessions-data-source";

const FILTERS = { limit: 25, offset: 0 } satisfies AgentSessionQueryFilters;

function row(
  id: string,
  externalSessionId = id,
  updatedAt = new Date("2026-10-19T12:00:00.000Z")
) {
  return createAgentSessionListItemFixture({
    externalSessionId,
    id,
    updatedAt,
  });
}

function response(
  items: AgentSessionListResponse["items"]
): AgentSessionListResponse {
  return {
    items,
    total: items.length,
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
  localSource: AgentSessionsDataSource
) {
  return createDesktopCloudPrimaryAgentSessionsDataSource({
    cloudSource,
    identity: { organizationId: "org-1", userId: "user-1" },
    localSource,
  });
}

describe("Desktop cloud-primary Sessions request routing", () => {
  it("routes concurrent detail, auxiliary, and mutation calls by session id", async () => {
    const cloudActivity = vi.fn<
      NonNullable<AgentSessionsDataSource["activityPage"]>
    >(async () => ({ items: [], nextCursor: null }));
    const localActivity = vi.fn<
      NonNullable<AgentSessionsDataSource["activityPage"]>
    >(async () => ({ items: [], nextCursor: null }));
    const cloudCustomFields = vi.fn<
      NonNullable<AgentSessionsDataSource["customFieldValues"]>
    >(async () => []);
    const localCustomFields = vi.fn<
      NonNullable<AgentSessionsDataSource["customFieldValues"]>
    >(async () => []);
    const cloudEvents = vi.fn<
      NonNullable<AgentSessionsDataSource["eventsPage"]>
    >(async () => ({ events: [] }));
    const localEvents = vi.fn<
      NonNullable<AgentSessionsDataSource["eventsPage"]>
    >(async () => ({ events: [] }));
    const cloudTree = vi.fn<
      NonNullable<AgentSessionsDataSource["sessionInvocationTree"]>
    >(async () => ({ items: [], total: 0 }));
    const localTree = vi.fn<
      NonNullable<AgentSessionsDataSource["sessionInvocationTree"]>
    >(async () => ({ items: [], total: 0 }));
    const cloudRename = vi.fn<
      NonNullable<AgentSessionsDataSource["renameSession"]>
    >(async () => undefined);
    const localRename = vi.fn<
      NonNullable<AgentSessionsDataSource["renameSession"]>
    >(async () => undefined);
    const cloudPriority = vi.fn<
      NonNullable<AgentSessionsDataSource["updatePriority"]>
    >(async () => undefined);
    const localPriority = vi.fn<
      NonNullable<AgentSessionsDataSource["updatePriority"]>
    >(async () => undefined);
    const cloud = source("cloud", {
      activityPage: cloudActivity,
      customFieldValues: cloudCustomFields,
      eventsPage: cloudEvents,
      list: vi
        .fn<AgentSessionsDataSource["list"]>()
        .mockResolvedValueOnce(response([row("cloud-id")]))
        .mockRejectedValueOnce(new Error("cloud refresh failed")),
      renameSession: cloudRename,
      sessionInvocationTree: cloudTree,
      updatePriority: cloudPriority,
    });
    const local = source("local", {
      activityPage: localActivity,
      customFieldValues: localCustomFields,
      eventsPage: localEvents,
      list: vi.fn(async () => response([row("local-id")])),
      renameSession: localRename,
      sessionInvocationTree: localTree,
      updatePriority: localPriority,
    });
    const dataSource = adapter(cloud, local);

    await dataSource.list(FILTERS);
    await dataSource.list(FILTERS);
    await Promise.allSettled([
      dataSource.detail("cloud-id"),
      dataSource.detail("local-id"),
    ]);
    await Promise.all([
      dataSource.activityPage?.({ sessionId: "cloud-id", limit: 10 }),
      dataSource.activityPage?.({ sessionId: "local-id", limit: 10 }),
      dataSource.customFieldValues?.("cloud-id"),
      dataSource.customFieldValues?.("local-id"),
      dataSource.eventsPage?.({ id: "cloud-id" }),
      dataSource.eventsPage?.({ id: "local-id" }),
      dataSource.sessionInvocationTree?.({ sessionId: "cloud-id" }),
      dataSource.sessionInvocationTree?.({ sessionId: "local-id" }),
      dataSource.renameSession?.("cloud-id", { name: "Cloud" }),
      dataSource.renameSession?.("local-id", { name: "Local" }),
      dataSource.updatePriority?.("cloud-id", { priority: null }),
    ]);

    expect(cloud.detail).toHaveBeenCalledWith("cloud-id", undefined);
    expect(local.detail).toHaveBeenCalledWith("local-id", undefined);
    expect(cloudActivity).toHaveBeenCalledWith({
      sessionId: "cloud-id",
      limit: 10,
    });
    expect(localActivity).toHaveBeenCalledWith({
      sessionId: "local-id",
      limit: 10,
    });
    expect(cloudCustomFields).toHaveBeenCalledWith("cloud-id");
    expect(localCustomFields).toHaveBeenCalledWith("local-id");
    expect(cloudEvents).toHaveBeenCalledWith({ id: "cloud-id" });
    expect(localEvents).toHaveBeenCalledWith({ id: "local-id" });
    expect(cloudTree).toHaveBeenCalledWith({ sessionId: "cloud-id" });
    expect(localTree).toHaveBeenCalledWith({ sessionId: "local-id" });
    expect(cloudRename).toHaveBeenCalledWith("cloud-id", { name: "Cloud" });
    expect(localRename).toHaveBeenCalledWith("local-id", { name: "Local" });
    expect(cloudPriority).toHaveBeenCalledWith("cloud-id", { priority: null });
    expect(
      agentSessionSourceSupports(
        dataSource,
        "local-id",
        AgentSessionCapability.UpdatePriority
      )
    ).toBe(false);
    if (!dataSource.updatePriority) {
      throw new Error("Cloud priority writer was not exposed.");
    }
    expect(() =>
      dataSource.updatePriority?.("local-id", { priority: null })
    ).toThrow("cannot serve priority update");
    expect(localPriority).not.toHaveBeenCalled();
  });

  it("withholds priority editing when fresher local evidence wins overlap", async () => {
    const cloudPriority = vi.fn<
      NonNullable<AgentSessionsDataSource["updatePriority"]>
    >(async () => undefined);
    const localPriority = vi.fn<
      NonNullable<AgentSessionsDataSource["updatePriority"]>
    >(async () => undefined);
    const cloud = source("cloud", {
      list: vi
        .fn<AgentSessionsDataSource["list"]>()
        .mockResolvedValueOnce(
          response([
            row(
              "cloud-row",
              "shared-external-id",
              new Date("2026-10-19T10:00:00.000Z")
            ),
          ])
        )
        .mockRejectedValueOnce(new Error("cloud refresh failed")),
      updatePriority: cloudPriority,
    });
    const local = source("local", {
      list: vi.fn(async () =>
        response([
          row(
            "local-row",
            "shared-external-id",
            new Date("2026-10-19T11:00:00.000Z")
          ),
        ])
      ),
      updatePriority: localPriority,
    });
    const dataSource = adapter(cloud, local);

    await dataSource.list(FILTERS);
    const fallback = await dataSource.list(FILTERS);
    expect(fallback.items.map((item) => item.id)).toEqual(["local-row"]);

    expect(
      agentSessionSourceSupports(
        dataSource,
        "local-row",
        AgentSessionCapability.UpdatePriority
      )
    ).toBe(false);
    if (!dataSource.updatePriority) {
      throw new Error("Cloud priority writer was not exposed.");
    }
    expect(() =>
      dataSource.updatePriority?.("local-row", { priority: null })
    ).toThrow("cannot serve priority update");
    expect(localPriority).not.toHaveBeenCalled();
    expect(cloudPriority).not.toHaveBeenCalled();
  });

  it("keeps equal-freshness routing on cloud", async () => {
    const updatedAt = new Date("2026-10-19T10:00:00.000Z");
    const cloudPriority = vi.fn<
      NonNullable<AgentSessionsDataSource["updatePriority"]>
    >(async () => undefined);
    const localPriority = vi.fn<
      NonNullable<AgentSessionsDataSource["updatePriority"]>
    >(async () => undefined);
    const dataSource = adapter(
      source("cloud", {
        list: vi
          .fn<AgentSessionsDataSource["list"]>()
          .mockResolvedValueOnce(
            response([row("cloud-row", "shared-external-id", updatedAt)])
          )
          .mockRejectedValueOnce(new Error("cloud refresh failed")),
        updatePriority: cloudPriority,
      }),
      source("local", {
        list: vi.fn(async () =>
          response([row("local-row", "shared-external-id", updatedAt)])
        ),
        updatePriority: localPriority,
      })
    );

    await dataSource.list(FILTERS);
    const fallback = await dataSource.list(FILTERS);
    expect(fallback.items.map((item) => item.id)).toEqual(["cloud-row"]);

    await dataSource.updatePriority?.("cloud-row", { priority: null });
    expect(cloudPriority).toHaveBeenCalledWith("cloud-row", { priority: null });
    expect(localPriority).not.toHaveBeenCalled();
  });

  it("partitions collaborator batches and capabilities by selected row source", async () => {
    const cloudCollaborators = vi.fn<
      NonNullable<AgentSessionsDataSource["collaborators"]>
    >(async () => ({ results: [] }));
    const cloudPriority = vi.fn<
      NonNullable<AgentSessionsDataSource["updatePriority"]>
    >(async () => undefined);
    const cloud = source("cloud", {
      collaborators: cloudCollaborators,
      list: vi
        .fn<AgentSessionsDataSource["list"]>()
        .mockResolvedValueOnce(response([row("cloud-id")]))
        .mockRejectedValueOnce(new Error("cloud refresh failed")),
      updatePriority: cloudPriority,
    });
    const local = source("local", {
      list: vi.fn(async () => response([row("local-id")])),
    });
    const dataSource = adapter(cloud, local);

    await dataSource.list(FILTERS);
    await dataSource.list(FILTERS);
    await dataSource.collaborators?.(["cloud-id", "local-id"]);

    expect(cloudCollaborators).toHaveBeenCalledWith(["cloud-id"]);
    expect(
      agentSessionSourceSupports(
        dataSource,
        "cloud-id",
        AgentSessionCapability.UpdatePriority
      )
    ).toBe(true);
    expect(
      agentSessionSourceSupports(
        dataSource,
        "local-id",
        AgentSessionCapability.UpdatePriority
      )
    ).toBe(false);
  });

  it("does not let a late same-scope list completion replace the newer cache", async () => {
    const first = deferred<AgentSessionListResponse>();
    const second = deferred<AgentSessionListResponse>();
    const cloudList = vi
      .fn<AgentSessionsDataSource["list"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockRejectedValueOnce(new Error("cloud unavailable"));
    const dataSource = adapter(
      source("cloud", { list: cloudList }),
      source("local", {
        list: vi.fn(() => Promise.reject(new Error("local unavailable"))),
      })
    );

    const olderRead = dataSource.list(FILTERS);
    const newerRead = dataSource.list(FILTERS);
    second.resolve(response([row("newer")]));
    await newerRead;
    first.resolve(response([row("older")]));
    await olderRead;

    const fallback = await dataSource.list(FILTERS);
    expect(fallback.items.map((item) => item.id)).toEqual(["newer"]);
  });

  it("does not let a late same-scope pageData completion replace the newer cache", async () => {
    const first = deferred<{ list: AgentSessionListResponse }>();
    const second = deferred<{ list: AgentSessionListResponse }>();
    const cloud = source("cloud", {
      list: vi.fn(() => Promise.reject(new Error("cloud unavailable"))),
      pageData: vi
        .fn<AgentSessionsDataSource["pageData"]>()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    });
    const dataSource = adapter(
      cloud,
      source("local", {
        list: vi.fn(() => Promise.reject(new Error("local unavailable"))),
      })
    );

    const olderRead = dataSource.pageData(FILTERS);
    const newerRead = dataSource.pageData(FILTERS);
    second.resolve({ list: response([row("newer-page")]) });
    await newerRead;
    first.resolve({ list: response([row("older-page")]) });
    await olderRead;

    const fallback = await dataSource.list(FILTERS);
    expect(fallback.items.map((item) => item.id)).toEqual(["newer-page"]);
  });

  it("passes one live signal through cloud and pending local reads and settles cancellation", async () => {
    const controller = new AbortController();
    const cloudList = vi.fn<AgentSessionsDataSource["list"]>(
      (_filters, options) => {
        expect(options?.signal).toBe(controller.signal);
        expect(options?.signal?.aborted).toBe(false);
        return Promise.reject(new Error("cloud failed"));
      }
    );
    const localStarted = deferred<void>();
    const localList = vi.fn<AgentSessionsDataSource["list"]>(
      (_filters, options) =>
        new Promise((_resolve, reject) => {
          expect(options?.signal).toBe(controller.signal);
          localStarted.resolve();
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true }
          );
        })
    );
    const dataSource = adapter(
      source("cloud", { list: cloudList }),
      source("local", { list: localList })
    );

    const read = dataSource.list(FILTERS, { signal: controller.signal });
    await localStarted.promise;
    controller.abort();

    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(cloudList).toHaveBeenCalledTimes(1);
    expect(localList).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}
