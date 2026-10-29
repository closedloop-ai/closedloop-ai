import {
  BATCH_ITEM_APPLIED_STATUS,
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
  batchItemApplied,
  batchItemAppliedWithOutcome,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Status } from "@repo/api/src/types/result";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import { toast } from "@repo/design-system/components/ui/sonner";
import type {
  TableBulkActionDescriptor,
  TableBulkSelectionControls,
} from "@repo/design-system/components/ui/table-bulk-actions";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { useGridRowSelection } from "@repo/design-system/hooks/use-grid-row-selection";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../../../agents/components/sessions/session-list-fixtures";
import { useSessionsBulkTagActions } from "../../../agents/components/sessions/use-sessions-bulk-tag-actions";
import { agentSessionKeys } from "../../../agents/hooks/agent-session-keys";
import { useBranchesBulkTagActions } from "../../../branches/components/use-branches-bulk-tag-actions";
import { createHttpBranchesDataSource } from "../../../branches/data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../../branches/data-source/provider";
import { branchRowQueryKeys } from "../../../branches/hooks/branch-query-keys";
import { BRANCH_SAMPLE_ROWS } from "../../../branches/lib/branch-sample-data";
import { ApiError, getFriendlyError } from "../../../shared/api/api-error";
import { useApiClient } from "../../../shared/api/use-api-client";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { ArtifactBulkActionBar } from "../../../shared/components/generic-artifact-surface/bulk-action-bar";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../shared/feature-flags/static-feature-flag-adapter";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import { createTestQueryClient } from "../../../shared/test-utils";
import {
  BULK_REMOVE_TAG_ACTION_LABEL,
  BULK_TAG_ACTION_LABEL,
} from "../../lib/bulk-tag-labels";
import {
  BulkTagMutation,
  type BulkTagMutation as BulkTagMutationValue,
} from "../../lib/bulk-tag-mutation";
import { createDeferred } from "../../test-fixtures/deferred";

const ROW_IDS = ["row-a", "row-b", "row-c"];
const TAGS = [
  { id: "tag-a", name: "backend", color: TagColor.Blue },
  { id: "tag-b", name: "urgent", color: TagColor.Red },
];
const SESSION_CACHE_KEY = agentSessionKeys.list("interaction-test", {});
const BRANCH_CACHE_KEY = [...branchRowQueryKeys.lists, "interaction-test"];
const ENDINGS = [
  "dismiss",
  "clear",
  "replace",
  "renew",
  "dispose",
  "withdraw",
  "auth",
  "user",
] as const;
type Entity = "sessions" | "branches";
type Ending = (typeof ENDINGS)[number];
type TargetChange =
  | "arrival"
  | "unrelated-permission"
  | "identity"
  | "permission"
  | "missing";
type Snapshot = {
  client: QueryClient;
  actions: readonly TableBulkActionDescriptor[];
  selection: TableBulkSelectionControls;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each(["sessions", "branches"] as const)(
  "%s interaction lifetime (DT-R01-R11)",
  (entity) => {
    it.each(
      ENDINGS.flatMap((ending) => [
        { ending, succeeds: true },
        { ending, succeeds: false },
      ])
    )(
      "suppresses late UI after $ending, success=$succeeds without cancelling same-auth writes",
      async ({ ending, succeeds }) => {
        const fixture = setup(entity);
        if (ending === "replace") {
          fixture.change("arrival");
        }
        const success = vi
          .spyOn(toast, "success")
          .mockReturnValue("fixture-toast");
        await fixture.submit();
        expect(fixture.action().isPending).toBe(true);
        await endInteraction(fixture, ending);
        await fixture.settle({
          results: artifactIds(entity).map((id) =>
            succeeds
              ? batchItemApplied(id)
              : batchItemFailed(id, BatchItemFailureCode.ArtifactsNotFound)
          ),
        });
        expect(fixture.writes).toEqual([
          {
            tagId: TAGS[0].id,
            entityType: TagEntityType.Artifact,
            entityIds: artifactIds(entity),
          },
        ]);
        expect(success).not.toHaveBeenCalled();
        expect(
          fixture.client.getQueryState(SESSION_CACHE_KEY)?.isInvalidated
        ).toBe(succeeds && ending !== "auth" && ending !== "user");
        if (
          entity === "branches" &&
          succeeds &&
          ending !== "auth" &&
          ending !== "user"
        ) {
          expect(fixture.branchInvalidation).toHaveBeenCalledWith({
            queryKey: branchRowQueryKeys.lists,
          });
        } else {
          expect(fixture.branchInvalidation).not.toHaveBeenCalled();
        }
        fixture.remount();
        if (ending !== "dispose") {
          let expected = "row-a,row-b";
          if (ending === "clear") {
            expected = "";
          } else if (ending === "replace") {
            expected = "row-b,row-c";
          }
          expect(screen.getByTestId("selection").textContent).toBe(expected);
        }
        await fixture.user.click(
          screen.getByRole("button", { name: "Select failed row" })
        );
        expect(screen.queryByRole("toolbar")).toBeNull();
        fireEvent.click(
          screen.getByRole("button", { name: "Renew selection" })
        );
        await fixture.user.click(
          screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
        );
        await screen.findByRole("button", { name: TAGS[0].name });
        expect(screen.queryByRole("alert")).toBeNull();
      }
    );

    // Operator ruling on the ISS-12305 review (Asana precedent): closing the
    // picker does not cancel the save, and the write never changes the
    // selection.
    it("lands a save the picker was closed on and keeps the selection", async () => {
      const fixture = setup(entity);
      await fixture.submit();
      await fixture.user.keyboard("{Escape}");
      await fixture.settle({
        results: artifactIds(entity).map(batchItemApplied),
      });
      expect(fixture.writes).toEqual([
        {
          tagId: TAGS[0].id,
          entityType: TagEntityType.Artifact,
          entityIds: artifactIds(entity),
        },
      ]);
      expect(screen.getByTestId("selection").textContent).toBe("row-a,row-b");
      expect(screen.getByRole("toolbar")).toBeInTheDocument();
    });

    it.each(["arrival", "unrelated-permission"] as const)(
      "keeps valid pending completion and retry through unrelated %s (VF-STATE-01)",
      async (change) => {
        const fixture = setup(entity);
        if (change === "unrelated-permission") {
          fixture.change("arrival");
        }
        await fixture.submit();
        fixture.change(change);
        await fixture.settle(partialReceipt(entity));
        expect(screen.getByTestId("selection").textContent).toBe("row-a,row-b");
        expect(screen.getByRole("toolbar")).toBeInTheDocument();
        expect(
          fixture
            .action()
            .canRetrySelection?.([ROW_IDS[1]], fixture.snapshot.selection)
        ).toBe(true);
        expect(
          fixture
            .action()
            .canRetrySelection?.([ROW_IDS[0]], fixture.snapshot.selection)
        ).toBe(false);
        expect(
          fixture
            .action()
            .canRetrySelection?.(
              [ROW_IDS[1], ROW_IDS[2]],
              fixture.snapshot.selection
            )
        ).toBe(false);
        fireEvent.click(
          screen.getByRole("button", { name: "Select failed row" })
        );
        expect(screen.getByTestId("selection").textContent).toBe("row-b");
        expect(screen.getByRole("toolbar")).toBeInTheDocument();
        await fixture.user.click(
          screen.getByRole("button", { name: TAGS[0].name })
        );
        await waitFor(() => expect(fixture.writes).toHaveLength(2));
        expect(fixture.writes[1]).toEqual({
          tagId: TAGS[0].id,
          entityType: TagEntityType.Artifact,
          entityIds: [artifactIds(entity)[1]],
        });
        await waitFor(() =>
          expect(
            screen.queryByRole("button", { name: TAGS[0].name })
          ).toBeNull()
        );
        expect(screen.getByTestId("selection").textContent).toBe("row-b");
      }
    );

    it("keeps Remove retry across the failed-row selection updates", async () => {
      const fixture = setup(entity, BulkTagMutation.Remove);
      await fixture.submit();
      await fixture.settle(partialReceipt(entity, BulkTagMutation.Remove));

      await fixture.user.click(
        screen.getByRole("button", { name: "Narrow to failed row" })
      );

      expect(screen.getByTestId("selection").textContent).toBe("row-b");
      expect(
        screen.getByRole("toolbar", { name: "1 artifact selected" })
      ).toBeInTheDocument();
      expect(
        fixture
          .action()
          .canRetrySelection?.([ROW_IDS[1]], fixture.snapshot.selection)
      ).toBe(true);

      await fixture.user.click(
        screen.getByRole("button", { name: TAGS[0].name })
      );
      await waitFor(() => expect(fixture.writes).toHaveLength(2));
      expect(fixture.writes[1]).toEqual({
        tagId: TAGS[0].id,
        entityType: TagEntityType.Artifact,
        entityIds: [artifactIds(entity)[1]],
      });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(screen.getByTestId("selection").textContent).toBe("row-b");
      expect(screen.queryByRole("toolbar")).toBeNull();
    });

    it("applies a different tag to the full selection after a partial result", async () => {
      const fixture = setup(entity);
      await fixture.submit();
      await fixture.settle(partialReceipt(entity));

      await fixture.user.click(
        screen.getByRole("button", { name: TAGS[1].name })
      );

      await waitFor(() => expect(fixture.writes).toHaveLength(2));
      expect(fixture.writes[1]).toEqual({
        tagId: TAGS[1].id,
        entityType: TagEntityType.Artifact,
        entityIds: artifactIds(entity),
      });
      expect(screen.getByTestId("selection").textContent).toBe("row-a,row-b");
    });

    it.each(["arrival", "unrelated-permission"] as const)(
      "preserves an established failed residue after unrelated %s (DT-R01)",
      async (change) => {
        const fixture = setup(entity);
        if (change === "unrelated-permission") {
          fixture.change("arrival");
        }
        await fixture.submit();
        await fixture.settle(partialReceipt(entity));
        fixture.change(change);
        expect(screen.getByTestId("selection").textContent).toBe("row-a,row-b");
        expect(
          screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
        ).toBeInTheDocument();
        expect(
          fixture
            .action()
            .canRetrySelection?.([ROW_IDS[1]], fixture.snapshot.selection)
        ).toBe(true);
      }
    );

    it.each(["identity", "permission", "missing"] as const)(
      "invalidates retry when the active failed target changes %s (DT-R02)",
      async (change) => {
        const fixture = setup(entity);
        await fixture.submit();
        await fixture.settle(partialReceipt(entity));
        expect(screen.getByRole("alert")).toBeInTheDocument();
        fixture.change(change);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(
          fixture
            .action()
            .canRetrySelection?.([ROW_IDS[1]], fixture.snapshot.selection)
        ).toBe(false);
        expect(fixture.writes).toHaveLength(1);
      }
    );

    it.each(["identity", "permission", "missing"] as const)(
      "suppresses pending partial UI when active B changes %s (DT-R02/R03)",
      async (change) => {
        const fixture = setup(entity);
        const success = vi
          .spyOn(toast, "success")
          .mockReturnValue("fixture-toast");
        await fixture.submit();
        fixture.change(change);
        await fixture.settle(partialReceipt(entity));
        expect(success).not.toHaveBeenCalled();
        expect(
          fixture
            .action()
            .canRetrySelection?.([ROW_IDS[1]], fixture.snapshot.selection)
        ).toBe(false);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(
          fixture.client.getQueryState(SESSION_CACHE_KEY)?.isInvalidated
        ).toBe(true);
        expect(fixture.writes).toHaveLength(1);
      }
    );

    it.each(ENDINGS)(
      "clears an already-established obsolete failure after %s (DT-R02)",
      async (ending) => {
        const fixture = setup(entity);
        if (ending === "replace") {
          fixture.change("arrival");
        }
        await fixture.submit();
        await fixture.settle(partialReceipt(entity));
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(
          fixture
            .action()
            .canRetrySelection?.([ROW_IDS[1]], fixture.snapshot.selection)
        ).toBe(true);
        await endInteraction(fixture, ending);
        fixture.remount();
        expect(
          fixture
            .action()
            .canRetrySelection?.([ROW_IDS[1]], fixture.snapshot.selection)
        ).toBe(false);
        expect(screen.queryByRole("alert")).toBeNull();
        fireEvent.click(
          screen.getByRole("button", { name: "Renew selection" })
        );
        await fixture.user.click(
          screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
        );
        await screen.findByRole("button", { name: TAGS[0].name });
        expect(screen.queryByRole("alert")).toBeNull();
        expect(fixture.writes).toHaveLength(1);
      }
    );

    it.each(["all-failed", "applied-with-code"] as const)(
      "does not refresh or acknowledge %s receipts (DT-B09)",
      async (wire) => {
        const fixture = setup(entity);
        const success = vi
          .spyOn(toast, "success")
          .mockReturnValue("fixture-toast");
        await fixture.submit();
        await fixture.settle({
          results: artifactIds(entity).map((id) =>
            wire === "all-failed"
              ? batchItemFailed(id, BatchItemFailureCode.ArtifactsNotFound)
              : {
                  ...batchItemFailed(
                    id,
                    BatchItemFailureCode.ArtifactsNotFound
                  ),
                  status: BATCH_ITEM_APPLIED_STATUS,
                }
          ),
        });
        expect(
          fixture.client.getQueryState(SESSION_CACHE_KEY)?.isInvalidated
        ).toBe(false);
        expect(fixture.branchInvalidation).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();
        expect(screen.getByTestId("selection").textContent).toBe("row-a,row-b");
        expect(screen.getByRole("alert")).toBeInTheDocument();
      }
    );

    it("rejects malformed trust-boundary receipts without cache refresh or UI success (DT-B02/B04)", async () => {
      const fixture = setup(entity);
      const success = vi
        .spyOn(toast, "success")
        .mockReturnValue("fixture-toast");
      await fixture.submit();
      await fixture.settle({ results: "not-a-result-list" }, "error");
      expect(
        fixture.client.getQueryState(SESSION_CACHE_KEY)?.isInvalidated
      ).toBe(false);
      expect(fixture.branchInvalidation).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
      expect(screen.getByTestId("selection").textContent).toBe("row-a,row-b");
      const error = fixture.client
        .getMutationCache()
        .getAll()
        .find((mutation) => mutation.state.status === "error")?.state.error;
      const expectedError = new ApiError(
        BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.OutcomeUnknown],
        Status.Error
      );
      expect(error).toMatchObject({
        message: expectedError.message,
        status: Status.Error,
      });
      expect(screen.getByRole("alert")).toHaveTextContent(
        getFriendlyError(expectedError).description
      );
    });

    it.each(["unrequested", "duplicate"] as const)(
      "refreshes durable caches without acknowledging %s receipt (DT-B01/B08)",
      async (wire) => {
        const fixture = setup(entity);
        const success = vi
          .spyOn(toast, "success")
          .mockReturnValue("fixture-toast");
        await fixture.submit();
        const first = artifactIds(entity)[0];
        await fixture.settle({
          results:
            wire === "unrequested"
              ? [batchItemApplied("unrequested-artifact")]
              : [batchItemApplied(first), batchItemApplied(first)],
        });
        expect(screen.getByTestId("selection")).toHaveTextContent(
          "row-a,row-b"
        );
        expect(success).not.toHaveBeenCalled();
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(
          fixture.client.getQueryState(SESSION_CACHE_KEY)?.isInvalidated
        ).toBe(true);
        if (entity === "branches") {
          expect(fixture.branchInvalidation).toHaveBeenCalledWith({
            queryKey: branchRowQueryKeys.lists,
          });
        }
      }
    );
  }
);

function setup(
  entity: Entity,
  operation: BulkTagMutationValue = BulkTagMutation.Add
) {
  const receipt = createDeferred<unknown>();
  const started = createDeferred<void>();
  const writes: unknown[] = [];
  const branchClient = createTestQueryClient();
  const branchInvalidation = vi.spyOn(branchClient, "invalidateQueries");
  let snapshot: Snapshot | undefined;
  const respondToMutation: FixtureRoute["respond"] = ({ body }) => {
    writes.push(body);
    if (writes.length === 1) {
      started.resolve();
      return receipt.promise;
    }
    const request = body as { entityIds: string[] };
    return {
      results: request.entityIds.map((id) =>
        operation === BulkTagMutation.Remove
          ? batchItemAppliedWithOutcome(id, BatchItemAppliedOutcome.Removed)
          : batchItemApplied(id)
      ),
    };
  };
  const routes: FixtureRoute[] = [
    { method: "GET", path: "/tags", respond: () => TAGS },
    {
      method: "POST",
      path: `${BatchMutationRoute.EntityTags}/v2`,
      respond: respondToMutation,
    },
    {
      method: "POST",
      path: `${BatchMutationRoute.EntityTagsRemove}/v2`,
      respond: respondToMutation,
    },
  ];
  let props = {
    change: undefined as TargetChange | undefined,
    enabled: true,
    orgId: "org_test",
    userId: "user_test",
    present: true,
    readOnly: false,
  };
  const tree = () => (
    <AppCoreStoryProviders
      apiRoutes={routes}
      queryData={[
        [SESSION_CACHE_KEY, []],
        [BRANCH_CACHE_KEY, []],
      ]}
    >
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          orgId: props.orgId,
          userId: props.userId,
        })}
      >
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: props.enabled
              ? [SESSIONS_ARTIFACT_TAGS_FLAG_KEY]
              : [],
          })}
        >
          <TooltipProvider>
            {props.present ? (
              <BranchOwner client={branchClient}>
                <Interaction
                  capture={(value) => {
                    snapshot = value;
                  }}
                  change={props.change}
                  entity={entity}
                  readOnly={props.readOnly}
                />
              </BranchOwner>
            ) : null}
          </TooltipProvider>
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    </AppCoreStoryProviders>
  );
  const view = render(tree());
  const initial = readSnapshot();
  const user = userEvent.setup({ delay: null });
  function readSnapshot() {
    if (!snapshot) {
      throw new Error("Interaction did not mount");
    }
    return snapshot;
  }
  function action() {
    const actionLabel =
      operation === BulkTagMutation.Remove
        ? BULK_REMOVE_TAG_ACTION_LABEL
        : BULK_TAG_ACTION_LABEL;
    const descriptor = readSnapshot().actions.find(
      ({ label }) => label === actionLabel
    );
    if (descriptor?.kind !== "picker") {
      throw new Error("Missing live tag picker");
    }
    return descriptor;
  }
  return {
    action,
    branchInvalidation,
    client: initial.client,
    user,
    writes,
    get snapshot() {
      return readSnapshot();
    },
    change: (change: TargetChange) => {
      props = { ...props, change };
      view.rerender(tree());
    },
    end: (ending: Ending) => {
      if (ending === "dispose") {
        props = { ...props, present: false };
      }
      if (ending === "withdraw") {
        props =
          entity === "sessions"
            ? { ...props, enabled: false }
            : { ...props, readOnly: true };
      }
      if (ending === "auth") {
        props = { ...props, orgId: "org_other" };
      }
      if (ending === "user") {
        props = { ...props, userId: "user_other" };
      }
      view.rerender(tree());
    },
    remount: () => {
      props = { ...props, present: true, enabled: true, readOnly: false };
      view.rerender(tree());
    },
    submit: async () => {
      await user.click(
        screen.getByRole("button", {
          name:
            operation === BulkTagMutation.Remove
              ? BULK_REMOVE_TAG_ACTION_LABEL
              : BULK_TAG_ACTION_LABEL,
        })
      );
      await user.click(
        await screen.findByRole("button", { name: TAGS[0].name })
      );
      await started.promise;
    },
    settle: async (
      response: unknown,
      expectedStatus: "success" | "error" = "success"
    ) => {
      await act(async () => {
        receipt.resolve(response);
        await receipt.promise;
      });
      await waitFor(() =>
        expect(
          initial.client
            .getMutationCache()
            .getAll()
            .some((mutation) => mutation.state.status === expectedStatus)
        ).toBe(true)
      );
      await act(async () => undefined);
    },
  };
}

function Interaction({
  entity,
  change,
  readOnly,
  capture,
}: {
  entity: Entity;
  change?: TargetChange;
  readOnly: boolean;
  capture: (snapshot: Snapshot) => void;
}) {
  const ids = change === "arrival" ? ROW_IDS : ROW_IDS.slice(0, 2);
  const availableIds =
    change === "missing" ? ids.filter((id) => id !== ROW_IDS[1]) : ids;
  const sessions = availableIds.map((id) =>
    createSessionTableRowFixture({
      id: change === "identity" && id === ROW_IDS[1] ? "replacement-row" : id,
      tagPermissions: {
        canApply: !(change === "permission" && id === ROW_IDS[1]),
        canRemove: false,
      },
    })
  );
  const branches = availableIds.map((id, index) => ({
    ...BRANCH_SAMPLE_ROWS[index],
    id,
    artifactId:
      change === "identity" && id === ROW_IDS[1]
        ? "replacement-artifact"
        : `artifact-${index}`,
    tagPermissions: {
      canApply: !(change === "permission" && id === ROW_IDS[1]),
      canRemove: false,
    },
  }));
  if (change === "unrelated-permission") {
    sessions.push(
      createSessionTableRowFixture({
        id: ROW_IDS[2],
        tagPermissions: { canApply: false, canRemove: false },
      })
    );
    branches.push({
      ...BRANCH_SAMPLE_ROWS[2],
      id: ROW_IDS[2],
      artifactId: "artifact-2",
      tagPermissions: { canApply: false, canRemove: false },
    });
  }
  const sessionActions = useSessionsBulkTagActions(sessions);
  const branchActions = useBranchesBulkTagActions(branches, readOnly);
  const actions = entity === "sessions" ? sessionActions : branchActions;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(ROW_IDS.slice(0, 2))
  );
  const selection = useGridRowSelection({
    controller: { selectedIds, onChange: setSelectedIds },
    visibleRowIds: availableIds,
  });
  const controls: TableBulkSelectionControls = {
    clear: selection.clearSelection,
    retain: selection.retainSelection,
    getGeneration: selection.getSelectionGeneration,
  };
  capture({ actions, selection: controls, client: useQueryClient() });
  return (
    <>
      <output data-testid="selection">
        {[...selection.selectedIds].sort().join(",")}
      </output>
      <button
        onClick={() => setSelectedIds(new Set([ROW_IDS[1]]))}
        type="button"
      >
        Select failed row
      </button>
      <button
        onClick={() => narrowToFailedRow(selection, entity)}
        type="button"
      >
        Narrow to failed row
      </button>
      <button
        onClick={() => setSelectedIds(new Set(ROW_IDS.slice(1)))}
        type="button"
      >
        Replace selection
      </button>
      <button
        onClick={() => {
          selection.clearSelection();
          selection.selectAllRows(ROW_IDS.slice(0, 2).map((id) => ({ id })));
        }}
        type="button"
      >
        Renew selection
      </button>
      <ArtifactBulkActionBar
        actions={actions}
        getSelectionGeneration={selection.getSelectionGeneration}
        minimumSelectedRows={2}
        onClear={selection.clearSelection}
        onRetainSelection={selection.retainSelection}
        rowIds={[...selection.selectedIds]}
      />
    </>
  );
}

async function endInteraction(
  fixture: ReturnType<typeof setup>,
  ending: Ending
) {
  if (ending === "dismiss") {
    await fixture.user.keyboard("{Escape}");
  }
  if (ending === "clear") {
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  }
  if (ending === "replace") {
    fireEvent.click(screen.getByRole("button", { name: "Replace selection" }));
  }
  if (ending === "renew") {
    fireEvent.click(screen.getByRole("button", { name: "Renew selection" }));
  }
  if (["dispose", "withdraw", "auth", "user"].includes(ending)) {
    fixture.end(ending);
  }
}

function artifactIds(entity: Entity): string[] {
  return entity === "sessions"
    ? ROW_IDS.slice(0, 2)
    : ["artifact-0", "artifact-1"];
}

function partialReceipt(
  entity: Entity,
  operation: BulkTagMutationValue = BulkTagMutation.Add
) {
  const ids = artifactIds(entity);
  return {
    results: [
      operation === BulkTagMutation.Remove
        ? batchItemAppliedWithOutcome(ids[0], BatchItemAppliedOutcome.Removed)
        : batchItemApplied(ids[0]),
      batchItemFailed(ids[1], BatchItemFailureCode.ArtifactsNotFound),
    ],
  };
}

function narrowToFailedRow(
  selection: ReturnType<typeof useGridRowSelection>,
  entity: Entity
) {
  if (entity === "branches") {
    selection.clearSelection();
    selection.selectAllRows([{ id: ROW_IDS[1] }]);
    return;
  }
  selection.toggleRowSelection({ id: ROW_IDS[0] });
}

function BranchOwner({
  client,
  children,
}: {
  client: QueryClient;
  children: ReactNode;
}) {
  const api = useApiClient();
  return (
    <BranchesDataSourceProvider
      dataSource={createHttpBranchesDataSource(api)}
      queryClient={client}
    >
      {children}
    </BranchesDataSourceProvider>
  );
}
