import { AgentSessionBulkAssignField } from "@repo/api/src/types/agent-session-bulk-assign";
import { ArtifactBulkAction } from "@repo/api/src/types/artifact-bulk-action";
import { batchItemApplied } from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { projectKeys } from "@repo/app/projects/hooks/project-keys";
import { ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { userKeys } from "@repo/app/users/hooks/use-users";
import { toast } from "@repo/design-system/components/ui/sonner";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSessionListItemFixture,
  createSessionTableRowFixture,
} from "../session-list-fixtures";
import { useSessionsRegisteredBulkActions } from "../use-sessions-registered-bulk-actions";

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CURRENT_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

describe("useSessionsRegisteredBulkActions", () => {
  it("publishes Move to project Undo and restores the previous project", async () => {
    const requests: unknown[] = [];
    const item = createAgentSessionListItemFixture({
      id: SESSION_ID,
      project: {
        id: CURRENT_PROJECT_ID,
        name: "TEST ONLY: Current project",
        slug: "current-project",
      },
    });
    const row = createSessionTableRowFixture({
      id: SESSION_ID,
      name: "TEST ONLY: Session",
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "POST",
            path: `${BatchMutationRoute.AgentSessionsAssign}/v2`,
            respond: ({ body }) => {
              requests.push(body);
              return {
                results: [batchItemApplied(SESSION_ID)],
                transactionId: `transaction-${requests.length}`,
              };
            },
          },
        ]}
        enabledFlags={[ARTIFACT_BULK_ACTION_BAR_FEATURE_FLAG_KEY]}
        queryData={[
          [
            projectKeys.list({ teamId: undefined }),
            [{ id: TARGET_PROJECT_ID, name: "TEST ONLY: Target project" }],
          ],
          [userKeys.organizationUsers(), []],
        ]}
      >
        {children}
      </AppCoreStoryProviders>
    );
    const { result } = renderHook(
      () =>
        useSessionsRegisteredBulkActions({
          items: [item],
          tagActions: [],
        }),
      { wrapper }
    );
    if (typeof result.current.actions !== "function") {
      throw new Error("Expected registered Sessions actions");
    }
    const move = result.current
      .actions([row])
      .find((action) => action.id === ArtifactBulkAction.ChangeProject);
    if (move?.kind !== "picker") {
      throw new Error("Expected Move to project picker");
    }
    const option = move.options.find(
      (candidate) => candidate.id === TARGET_PROJECT_ID
    );
    if (!option) {
      throw new Error("Expected target project option");
    }

    await act(async () => {
      await move.onSelect([SESSION_ID], option, {
        clear: vi.fn(),
        retain: vi.fn(),
      });
    });

    expect(toast.success).toHaveBeenCalledWith(
      "Move to project applied to 1 sessions",
      { action: { label: "Undo", onClick: expect.any(Function) } }
    );
    const toastOptions = vi.mocked(toast.success).mock.calls[0]?.[1];
    const toastAction = toastOptions?.action;
    const undo =
      toastAction &&
      typeof toastAction === "object" &&
      "onClick" in toastAction &&
      typeof toastAction.onClick === "function"
        ? toastAction.onClick
        : undefined;
    if (!undo) {
      throw new Error("Expected Undo toast action");
    }
    await act(async () => {
      await Reflect.apply(undo, undefined, []);
    });

    expect(requests).toEqual([
      {
        sessionIds: [SESSION_ID],
        field: AgentSessionBulkAssignField.Project,
        value: TARGET_PROJECT_ID,
      },
      {
        sessionIds: [SESSION_ID],
        field: AgentSessionBulkAssignField.Project,
        value: CURRENT_PROJECT_ID,
      },
    ]);
  });
});
