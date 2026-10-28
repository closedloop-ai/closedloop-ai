import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
  batchItemApplied,
  batchItemAppliedWithOutcome,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import { TagEntityType } from "@repo/api/src/types/tag";
import {
  type TableBulkActionDescriptor,
  TableBulkActionLifecycle,
} from "@repo/design-system/components/ui/table-bulk-actions";
import { useQueryClient } from "@tanstack/react-query";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../../../agents/components/sessions/session-list-fixtures";
import { useSessionsBulkTagActions } from "../../../agents/components/sessions/use-sessions-bulk-tag-actions";
import { agentSessionKeys } from "../../../agents/hooks/agent-session-keys";
import { useBranchesBulkTagActions } from "../../../branches/components/use-branches-bulk-tag-actions";
import { BRANCH_SAMPLE_ROWS } from "../../../branches/lib/branch-sample-data";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../shared/feature-flags/static-feature-flag-adapter";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { createWrapper } from "../../../shared/test-utils";
import { BULK_REMOVE_TAG_ACTION_ID } from "../../lib/bulk-tag-labels";
import { createDeferred } from "../../test-fixtures/deferred";

const IDS = ["artifact-a", "artifact-b"];
const SESSIONS = IDS.map((id) =>
  createSessionTableRowFixture({
    id,
    tagPermissions: { canApply: true, canRemove: false },
  })
);
const BRANCHES = IDS.map((artifactId, index) => ({
  ...BRANCH_SAMPLE_ROWS[index],
  id: `branch-${index}`,
  artifactId,
  tagPermissions: { canApply: true, canRemove: false },
}));
const OPTION = { id: "tag-a", label: "backend" };
const mockToastSuccess = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  mockToastSuccess.mockClear();
});

describe("tag adapter eligibility", () => {
  it.each(["sessions", "branches"] as const)(
    "uses %s bulk-write permission and canonical artifact identity (ISS-10686 AC-007/AC-008)",
    async (surface) => {
      const writes: unknown[] = [];
      const sessionRows = IDS.map((id, index) =>
        createSessionTableRowFixture({
          id,
          tagPermissions: {
            canApply: index === 0,
            canRemove: index === 1,
          },
        })
      );
      const branchRows = IDS.map((artifactId, index) => ({
        ...BRANCH_SAMPLE_ROWS[index],
        id: `branch-${index}`,
        artifactId,
        tagPermissions: {
          canApply: index === 0,
          canRemove: index === 1,
        },
      }));
      const wrapper = ({ children }: { children: ReactNode }) => (
        <AppCoreStoryProviders
          apiRoutes={[
            {
              method: "POST",
              path: "/entity-tags/batch-remove/v2",
              respond: ({ body }) => {
                writes.push(body);
                return {
                  results: [
                    batchItemAppliedWithOutcome(
                      IDS[0],
                      BatchItemAppliedOutcome.Removed
                    ),
                  ],
                };
              },
            },
          ]}
          enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
        >
          {children}
        </AppCoreStoryProviders>
      );
      const { result } = renderHook(
        () => {
          const sessionActions = useSessionsBulkTagActions(sessionRows);
          const branchActions = useBranchesBulkTagActions(branchRows);
          return surface === "sessions" ? sessionActions : branchActions;
        },
        { wrapper }
      );
      const rowIds = surface === "sessions" ? [IDS[0]] : ["branch-0"];
      const deniedRowIds = surface === "sessions" ? [IDS[1]] : ["branch-1"];
      const selection = {
        clear: vi.fn(),
        retain: vi.fn(),
      };

      await act(async () => {
        await removePicker(result.current).onSelect(rowIds, OPTION, selection);
        expect(
          await removePicker(result.current).onSelect(
            deniedRowIds,
            OPTION,
            selection
          )
        ).toBe(false);
      });
      expect(
        removePicker(result.current).render?.({
          rowIds: deniedRowIds,
          selection,
          selectOption: vi.fn(),
        })
      ).toBeNull();

      expect(writes).toEqual([
        {
          tagId: OPTION.id,
          entityType: TagEntityType.Artifact,
          entityIds: [IDS[0]],
        },
      ]);
    }
  );

  it.each([
    ["sessions", false, BATCH_MUTATION_ENTITY_LIMIT + 1],
    ["sessions", true, BATCH_MUTATION_ENTITY_LIMIT + 1],
    ["branches", false, BATCH_MUTATION_ENTITY_LIMIT + 1],
    ["branches", true, BATCH_MUTATION_ENTITY_LIMIT + 1],
    ["sessions", true, 2],
    ["branches", true, 2],
  ] as const)(
    "honours live auth after true %s owner unmount (switch=%s, count=%s, DT-R04/R10)",
    async (entity, switchAccount, count) => {
      const ids = Array.from(
        { length: count },
        (_, index) => `unmount-artifact-${index}`
      );
      const sessions = ids.map((id) =>
        createSessionTableRowFixture({
          id,
          tagPermissions: { canApply: true, canRemove: false },
        })
      );
      const branches = ids.map((artifactId) => ({
        ...BRANCH_SAMPLE_ROWS[0],
        id: artifactId,
        artifactId,
        tagPermissions: { canApply: true, canRemove: false },
      }));
      const receipt = createDeferred<unknown>();
      const started = createDeferred<void>();
      const writes: unknown[] = [];
      const snapshots: Array<{
        actions: readonly TableBulkActionDescriptor[];
        client: ReturnType<typeof useQueryClient>;
      }> = [];
      const key = agentSessionKeys.list("true-unmount-test", {});
      function Owner() {
        const sessionActions = useSessionsBulkTagActions(sessions);
        const branchActions = useBranchesBulkTagActions(branches);
        snapshots.push({
          actions: entity === "sessions" ? sessionActions : branchActions,
          client: useQueryClient(),
        });
        return null;
      }
      const tree = (mounted: boolean, orgId: string) => (
        <AppCoreStoryProviders
          apiRoutes={[
            {
              method: "POST",
              path: "/entity-tags/batch/v2",
              respond: ({ body }) => {
                writes.push(body);
                if (writes.length === 1) {
                  started.resolve();
                  return receipt.promise;
                }
                return {
                  results: [batchItemApplied(ids[BATCH_MUTATION_ENTITY_LIMIT])],
                };
              },
            },
          ]}
          enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
          queryData={[[key, []]]}
        >
          <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId })}>
            {mounted ? <Owner /> : null}
          </AuthAdapterProvider>
        </AppCoreStoryProviders>
      );
      const { rerender } = render(tree(true, "org-first"));
      const snapshot = snapshots.at(-1);
      if (!snapshot) {
        throw new Error("Expected the mounted production adapter");
      }
      const selection = { clear: vi.fn(), retain: vi.fn() };
      let pending: Promise<boolean> | boolean | undefined;
      await act(async () => {
        pending = picker(snapshot.actions).onSelect(ids, OPTION, selection);
        await started.promise;
      });
      rerender(tree(false, "org-first"));
      if (switchAccount) {
        rerender(tree(false, "org-other"));
      }
      await act(async () => {
        receipt.resolve({
          results: ids
            .slice(0, BATCH_MUTATION_ENTITY_LIMIT)
            .map(batchItemApplied),
        });
        await pending;
      });
      const expected = [
        {
          tagId: OPTION.id,
          entityType: TagEntityType.Artifact,
          entityIds: ids.slice(0, BATCH_MUTATION_ENTITY_LIMIT),
        },
      ];
      if (!switchAccount) {
        expected.push({
          tagId: OPTION.id,
          entityType: TagEntityType.Artifact,
          entityIds: ids.slice(BATCH_MUTATION_ENTITY_LIMIT),
        });
      }
      expect(writes).toEqual(expected);
      expect(snapshot.client.getQueryState(key)?.isInvalidated).toBe(
        !switchAccount
      );
      expect(selection.clear).not.toHaveBeenCalled();
      expect(selection.retain).not.toHaveBeenCalled();
    }
  );
  it.each(["dispose", "auth"] as const)(
    "keeps submitted chunks independent of UI disposal but honours %s scope (DT-B05/R04/R10)",
    async (ending) => {
      const ids = Array.from(
        { length: BATCH_MUTATION_ENTITY_LIMIT + 1 },
        (_, index) => `artifact-${index}`
      );
      const rows = ids.map((id) =>
        createSessionTableRowFixture({
          id,
          tagPermissions: { canApply: true, canRemove: false },
        })
      );
      const receipt = createDeferred<unknown>();
      const started = createDeferred<void>();
      const writes: unknown[] = [];
      const key = agentSessionKeys.list("chunk-test", {});
      let orgId = "org-first";
      const wrapper = ({ children }: { children: ReactNode }) => (
        <AppCoreStoryProviders
          apiRoutes={[
            {
              method: "POST",
              path: "/entity-tags/batch/v2",
              respond: ({ body }) => {
                writes.push(body);
                if (writes.length === 1) {
                  started.resolve();
                  return receipt.promise;
                }
                return {
                  results: [batchItemApplied(ids[BATCH_MUTATION_ENTITY_LIMIT])],
                };
              },
            },
          ]}
          enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
          queryData={[[key, []]]}
        >
          <AuthAdapterProvider adapter={createStaticAuthAdapter({ orgId })}>
            {children}
          </AuthAdapterProvider>
        </AppCoreStoryProviders>
      );
      const { result, rerender } = renderHook(
        () => ({
          actions: useSessionsBulkTagActions(rows),
          client: useQueryClient(),
        }),
        { wrapper }
      );
      const selection = { clear: vi.fn(), retain: vi.fn() };
      let pending: Promise<boolean> | boolean | undefined;
      await act(async () => {
        pending = picker(result.current.actions).onSelect(
          ids,
          OPTION,
          selection
        );
        await started.promise;
      });
      if (ending === "dispose") {
        act(() =>
          picker(result.current.actions).onLifecycle?.({
            kind: TableBulkActionLifecycle.Dispose,
            rowIds: ids,
            selection,
          })
        );
      } else {
        orgId = "org-other";
        rerender();
      }
      await act(async () => {
        receipt.resolve({
          results: ids
            .slice(0, BATCH_MUTATION_ENTITY_LIMIT)
            .map(batchItemApplied),
        });
        await pending;
      });
      const expected = [
        {
          tagId: OPTION.id,
          entityType: TagEntityType.Artifact,
          entityIds: ids.slice(0, BATCH_MUTATION_ENTITY_LIMIT),
        },
      ];
      if (ending === "dispose") {
        expected.push({
          tagId: OPTION.id,
          entityType: TagEntityType.Artifact,
          entityIds: ids.slice(BATCH_MUTATION_ENTITY_LIMIT),
        });
      }
      expect(writes).toEqual(expected);
      expect(result.current.client.getQueryState(key)?.isInvalidated).toBe(
        ending === "dispose"
      );
      expect(selection.clear).not.toHaveBeenCalled();
      expect(selection.retain).not.toHaveBeenCalled();
      expect(picker(result.current.actions).canRetrySelection?.([ids[0]])).toBe(
        false
      );
    }
  );
  it("prevents a second submission while the first write is pending", async () => {
    const receipt = createDeferred<unknown>();
    const started = createDeferred<void>();
    const writes: unknown[] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: "/entity-tags/batch/v2",
            respond: ({ body }) => {
              writes.push(body);
              started.resolve();
              return receipt.promise;
            },
          },
        ]}
        enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
      >
        {children}
      </AppCoreStoryProviders>
    );
    const rows = IDS.map((id) =>
      createSessionTableRowFixture({
        id,
        tagPermissions: { canApply: true, canRemove: true },
      })
    );
    const { result } = renderHook(() => useSessionsBulkTagActions(rows), {
      wrapper,
    });
    const selection = { clear: vi.fn(), retain: vi.fn() };
    let first: Promise<boolean> | boolean | undefined;
    await act(async () => {
      first = picker(result.current).onSelect(IDS, OPTION, selection);
      await started.promise;
    });
    expect(picker(result.current).isPending).toBe(true);
    expect(removePicker(result.current).isPending).toBe(true);
    await act(async () => {
      expect(
        await removePicker(result.current).onSelect(IDS, OPTION, selection)
      ).toBe(false);
    });
    await act(async () => {
      receipt.resolve({ results: IDS.map(batchItemApplied) });
      await first;
    });
    expect(writes).toHaveLength(1);
    // Operator ruling on the ISS-12305 review (Asana precedent): a tag write
    // keeps the selection.
    expect(selection.clear).not.toHaveBeenCalled();
    expect(selection.retain).not.toHaveBeenCalled();
  });
  it.each(["sessions", "branches"] as const)(
    "refuses a mixed-eligibility %s selection without submitting a subset",
    async (entity) => {
      const requests: unknown[] = [];
      const wrapper = ({ children }: { children: ReactNode }) => (
        <AppCoreStoryProviders
          apiRoutes={[
            {
              method: "POST",
              path: "/entity-tags/batch/v2",
              respond: ({ body }) => {
                requests.push(body);
                return { results: IDS.map(batchItemApplied) };
              },
            },
          ]}
          enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
        >
          {children}
        </AppCoreStoryProviders>
      );
      const { result } = renderHook(
        () => {
          const sessionActions = useSessionsBulkTagActions([
            ...SESSIONS,
            createSessionTableRowFixture({
              id: "denied",
              tagPermissions: { canApply: false, canRemove: true },
            }),
            createSessionTableRowFixture({
              id: "legacy-without-permission",
            }),
          ]);
          const branchActions = useBranchesBulkTagActions([
            ...BRANCHES,
            {
              ...BRANCHES[0],
              id: "denied",
              artifactId: "denied-artifact",
              tagPermissions: { canApply: false, canRemove: true },
            },
            { ...BRANCHES[0], id: "local", artifactId: undefined },
          ]);
          return entity === "sessions" ? sessionActions : branchActions;
        },
        { wrapper }
      );
      const clear = vi.fn();
      const retain = vi.fn();
      const rowIds =
        entity === "sessions"
          ? [...IDS, "denied", "legacy-without-permission"]
          : ["branch-0", "branch-1", "denied", "local"];
      await act(async () => {
        expect(
          await picker(result.current).onSelect(rowIds, OPTION, {
            clear,
            retain,
          })
        ).toBe(false);
      });
      expect(
        picker(result.current).render?.({
          rowIds,
          selection: { clear, retain },
          selectOption: vi.fn(),
        })
      ).toBeNull();
      expect(requests).toEqual([]);
      expect(clear).not.toHaveBeenCalled();
      expect(retain).not.toHaveBeenCalled();
    }
  );

  it("withholds Desktop Sessions selection offline while other ineligible adapters keep inert capability actions", async () => {
    const requests: unknown[] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: "/entity-tags/batch/v2",
            respond: ({ body }) => {
              requests.push(body);
              return { results: IDS.map(batchItemApplied) };
            },
          },
        ]}
        enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
      >
        {children}
      </AppCoreStoryProviders>
    );
    const selection = { clear: vi.fn(), retain: vi.fn() };
    const offline = renderHook(
      ({ readOnly, rows }) => useBranchesBulkTagActions(rows, readOnly),
      { initialProps: { readOnly: true, rows: BRANCHES }, wrapper }
    );
    const offlineSessions = renderHook(
      () => useSessionsBulkTagActions(SESSIONS, true),
      { wrapper }
    );
    const denied = renderHook(
      () =>
        useBranchesBulkTagActions(
          BRANCHES.map((row) => ({
            ...row,
            tagPermissions: { canApply: false, canRemove: false },
          }))
        ),
      { wrapper }
    );
    const local = renderHook(
      () =>
        useSessionsBulkTagActions([
          createSessionTableRowFixture({ id: "local" }),
        ]),
      { wrapper }
    );
    const cases = [
      {
        actions: offline.result.current,
        rowIds: ["branch-0", "branch-1"],
      },
      { actions: denied.result.current, rowIds: ["branch-0", "branch-1"] },
      { actions: local.result.current, rowIds: ["local"] },
    ];
    expect(offlineSessions.result.current).toEqual([]);
    for (const { actions, rowIds } of cases) {
      expect(actions).toHaveLength(2);
      expect(
        picker(actions).render?.({ rowIds, selection, selectOption: vi.fn() })
      ).toBeNull();
      await act(async () => {
        expect(await picker(actions).onSelect(rowIds, OPTION, selection)).toBe(
          false
        );
      });
    }
    expect(requests).toEqual([]);
  });

  it("mounts safely without an API adapter and offers no cloud write", () => {
    const QueryWrapper = createWrapper();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryWrapper>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: [SESSIONS_ARTIFACT_TAGS_FLAG_KEY],
          })}
        >
          {children}
        </FeatureFlagAdapterProvider>
      </QueryWrapper>
    );
    const { result } = renderHook(() => useSessionsBulkTagActions(SESSIONS), {
      wrapper,
    });
    expect(result.current).toEqual([]);
  });

  it("preserves Add's failed-selection retry contract", async () => {
    const requests: Array<{ entityIds: string[] }> = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: "/entity-tags/batch/v2",
            respond: ({ body }) => {
              const request = body as { entityIds: string[] };
              requests.push(request);
              return {
                results:
                  requests.length === 1
                    ? [batchItemApplied(IDS[0])]
                    : request.entityIds.map(batchItemApplied),
              };
            },
          },
        ]}
        enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
      >
        {children}
      </AppCoreStoryProviders>
    );
    const { result } = renderHook(() => useSessionsBulkTagActions(SESSIONS), {
      wrapper,
    });
    const retain = vi.fn();
    await act(async () => {
      await picker(result.current).onSelect(IDS, OPTION, {
        clear: vi.fn(),
        retain,
      });
    });
    expect(requests).toHaveLength(1);
    expect(retain).not.toHaveBeenCalled();
    expect(picker(result.current).canRetrySelection?.([IDS[1]])).toBe(true);
    expect(picker(result.current).canRetrySelection?.([IDS[0]])).toBe(false);
    await act(async () => {
      await picker(result.current).onSelect([IDS[1]], OPTION, {
        clear: vi.fn(),
        retain,
      });
    });
    expect(requests.map(({ entityIds }) => entityIds)).toEqual([IDS, [IDS[1]]]);
    expect(retain).not.toHaveBeenCalled();
  });

  it("gives Remove Tag the same failed-selection retry contract", async () => {
    const requests: Array<{ entityIds: string[] }> = [];
    const rows = IDS.map((id) =>
      createSessionTableRowFixture({
        id,
        tagPermissions: { canApply: true, canRemove: true },
      })
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: "/entity-tags/batch-remove/v2",
            respond: ({ body }) => {
              const request = body as { entityIds: string[] };
              requests.push(request);
              if (requests.length === 1) {
                return {
                  results: [
                    batchItemAppliedWithOutcome(
                      IDS[0],
                      BatchItemAppliedOutcome.Removed
                    ),
                    batchItemFailed(
                      IDS[1],
                      BatchItemFailureCode.ArtifactsNotFound
                    ),
                  ],
                };
              }
              return {
                results: [
                  batchItemAppliedWithOutcome(
                    IDS[1],
                    BatchItemAppliedOutcome.Removed
                  ),
                ],
              };
            },
          },
        ]}
        enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
      >
        {children}
      </AppCoreStoryProviders>
    );
    const { result } = renderHook(() => useSessionsBulkTagActions(rows), {
      wrapper,
    });
    const retain = vi.fn();
    const selection = { clear: vi.fn(), retain };

    await act(async () => {
      await removePicker(result.current).onSelect(IDS, OPTION, selection);
    });

    expect(retain).not.toHaveBeenCalled();
    expect(removePicker(result.current).canRetrySelection?.([IDS[1]])).toBe(
      true
    );
    expect(removePicker(result.current).canRetrySelection?.([IDS[0]])).toBe(
      false
    );
    await act(async () => {
      await removePicker(result.current).onSelect([IDS[1]], OPTION, selection);
    });
    expect(requests.map(({ entityIds }) => entityIds)).toEqual([IDS, [IDS[1]]]);
  });

  it("does not invent success copy for confirmed removals", async () => {
    const rows = IDS.map((id) =>
      createSessionTableRowFixture({
        id,
        tagPermissions: { canApply: true, canRemove: true },
      })
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: "/entity-tags/batch-remove/v2",
            respond: () => ({
              results: [
                batchItemAppliedWithOutcome(
                  IDS[0],
                  BatchItemAppliedOutcome.Removed
                ),
                batchItemAppliedWithOutcome(
                  IDS[1],
                  BatchItemAppliedOutcome.NotPresent
                ),
              ],
            }),
          },
        ]}
        enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
      >
        {children}
      </AppCoreStoryProviders>
    );
    const { result } = renderHook(() => useSessionsBulkTagActions(rows), {
      wrapper,
    });

    await act(async () => {
      await removePicker(result.current).onSelect(IDS, OPTION, {
        clear: vi.fn(),
        retain: vi.fn(),
      });
    });

    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("does not invent success copy when every removal is a no-op", async () => {
    const rows = IDS.map((id) =>
      createSessionTableRowFixture({
        id,
        tagPermissions: { canApply: true, canRemove: true },
      })
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: "/entity-tags/batch-remove/v2",
            respond: () => ({
              results: IDS.map((id) =>
                batchItemAppliedWithOutcome(
                  id,
                  BatchItemAppliedOutcome.NotPresent
                )
              ),
            }),
          },
        ]}
        enabledFlags={[SESSIONS_ARTIFACT_TAGS_FLAG_KEY]}
      >
        {children}
      </AppCoreStoryProviders>
    );
    const { result } = renderHook(() => useSessionsBulkTagActions(rows), {
      wrapper,
    });

    await act(async () => {
      await removePicker(result.current).onSelect(IDS, OPTION, {
        clear: vi.fn(),
        retain: vi.fn(),
      });
    });

    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});

function picker(actions: readonly TableBulkActionDescriptor[]) {
  const action = actions[0];
  if (action?.kind !== "picker") {
    throw new Error("Expected the add-only picker descriptor");
  }
  return action;
}

function removePicker(actions: readonly TableBulkActionDescriptor[]) {
  const action = actions.find(({ id }) => id === BULK_REMOVE_TAG_ACTION_ID);
  if (action?.kind !== "picker") {
    throw new Error("Expected the remove tag picker descriptor");
  }
  return action;
}
