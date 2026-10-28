import { AgentSessionBulkAssignField } from "@repo/api/src/types/agent-session-bulk-assign";
import {
  ARTIFACT_BULK_ACTION_KINDS,
  ArtifactBulkAction,
  type ArtifactBulkAction as ArtifactBulkActionValue,
  ArtifactBulkKind,
  type ArtifactBulkKind as ArtifactBulkKindValue,
} from "@repo/api/src/types/artifact-bulk-action";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  BatchItemFailureCode,
  type BatchItemResult,
  type BatchMutationResponse,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { isPriority } from "@repo/api/src/types/priority-contract";

/** One selected row, already classified by its owning surface. */
export type ArtifactBulkRow = {
  id: string;
  kind: ArtifactBulkKindValue;
  /** The owning surface's row name, retained for partial-action confirmation. */
  label?: string;
};

export type ArtifactBulkExecution = {
  results: BatchItemResult[];
  transactionIds: string[];
  /** A request-level refusal already classified by its owning action. */
  failureMessage?: string;
};

export type ArtifactBulkExecutor = (
  rows: readonly ArtifactBulkRow[],
  value: string | boolean | null
) => Promise<ArtifactBulkExecution>;

export type ArtifactBulkHost = {
  post: (route: string, body: unknown) => Promise<BatchMutationResponse>;
  canPerform?: (action: ArtifactBulkActionValue) => boolean;
  /** Optional row-level eligibility after the canonical kind check. */
  canApply?: (action: ArtifactBulkActionValue, row: ArtifactBulkRow) => boolean;
  /** Kinds the page can display, independent of the current selection. */
  pageKinds?: readonly ArtifactBulkKindValue[];
  /** Surface-specific semantics stay here until a shared route exists. */
  executors?: Partial<Record<ArtifactBulkActionValue, ArtifactBulkExecutor>>;
};

/** Keep the complete selection beside the rows one action may mutate. */
export type ArtifactBulkActionPartition = {
  selectedRows: readonly ArtifactBulkRow[];
  applicableRows: readonly ArtifactBulkRow[];
  inapplicableRows: readonly ArtifactBulkRow[];
};

export type ArtifactBulkActionEntry = {
  id: string;
  supportedIds: string[];
  partition?: ArtifactBulkActionPartition;
  execute: (value: string | boolean | null) => Promise<ArtifactBulkExecution>;
};

/** Build actions from the contract, keeping host-specific extras unchanged. */
export function createArtifactBulkActionRegistry(input: {
  rows: readonly ArtifactBulkRow[];
  host: ArtifactBulkHost;
  extras?: readonly ArtifactBulkActionEntry[];
}): ArtifactBulkActionEntry[] {
  const { rows, host } = input;
  const actions = Object.values(ArtifactBulkAction).flatMap((action) => {
    if (
      host.pageKinds &&
      !host.pageKinds.some((kind) => ARTIFACT_BULK_ACTION_KINDS[action][kind])
    ) {
      return [];
    }
    if (host.canPerform?.(action) === false) {
      return [];
    }
    if (rows.length === 0) {
      return [];
    }
    const applicableRows = rows.filter(
      (row) =>
        ARTIFACT_BULK_ACTION_KINDS[action][row.kind] &&
        host.canApply?.(action, row) !== false
    );
    const applicableIds = new Set(applicableRows.map((row) => row.id));
    const inapplicableRows = rows.filter((row) => !applicableIds.has(row.id));
    const executor = host.executors?.[action];
    if (
      !(
        executor ||
        hasSharedExecutor(action, applicableRows, host.pageKinds !== undefined)
      )
    ) {
      return [];
    }
    return [
      {
        id: action,
        supportedIds: applicableRows.map((row) => row.id),
        partition: { selectedRows: rows, applicableRows, inapplicableRows },
        execute: (value: string | boolean | null) => {
          if (applicableRows.length === 0) {
            throw new RangeError("Bulk action has no applicable rows");
          }
          return executor
            ? executor(applicableRows, value)
            : executeSharedArtifactBulkAction(
                host,
                action,
                applicableRows,
                value
              );
        },
      },
    ];
  });
  return [...actions, ...(input.extras ?? [])];
}

/** Execute the shared owner/favorite routes and merge their item receipts. */
export async function executeSharedArtifactBulkAction(
  host: ArtifactBulkHost,
  action: ArtifactBulkActionValue,
  rows: readonly ArtifactBulkRow[],
  value: string | boolean | null
): Promise<ArtifactBulkExecution> {
  if (rows.length === 0 || rows.length > BATCH_MUTATION_ENTITY_LIMIT) {
    throw new RangeError("Bulk action selection is outside the entity limit");
  }
  if (!rows.every((row) => ARTIFACT_BULK_ACTION_KINDS[action][row.kind])) {
    throw new TypeError("Bulk action is not valid for every selected row");
  }
  const groups = routeGroups(action, rows, value);
  const settlements = await Promise.allSettled(
    groups.map((group) => host.post(group.route, group.body))
  );
  const responses = settlements.flatMap((settlement) =>
    settlement.status === "fulfilled" ? [settlement.value] : []
  );
  const byId = new Map(
    responses.flatMap((response) =>
      response.results.map((result) => [result.id, result] as const)
    )
  );
  for (const [index, settlement] of settlements.entries()) {
    if (settlement.status === "rejected") {
      for (const id of groups[index]?.ids ?? []) {
        byId.set(id, batchItemFailed(id, BatchItemFailureCode.OutcomeUnknown));
      }
    }
  }
  return {
    results: [...new Set(rows.map((row) => row.id))].map(
      (id) =>
        byId.get(id) ?? batchItemFailed(id, BatchItemFailureCode.OutcomeUnknown)
    ),
    transactionIds: responses.flatMap((response) =>
      response.transactionId ? [response.transactionId] : []
    ),
  };
}

type RouteGroup = { route: string; body: unknown; ids: string[] };

function routeGroups(
  action: ArtifactBulkActionValue,
  rows: readonly ArtifactBulkRow[],
  value: string | boolean | null
): RouteGroup[] {
  if (action === ArtifactBulkAction.ChangeStatus) {
    assertDocumentRows(rows, action);
    if (typeof value !== "string") {
      throw new TypeError("Status bulk action requires a status");
    }
    return [
      {
        route: `${BatchMutationRoute.DocumentsUpdateStatus}/v2`,
        body: {
          documentIds: rows.map((row) => row.id),
          status: value,
          surface: ArtifactStatusEditSurface.Bulk,
        },
        ids: rows.map((row) => row.id),
      },
    ];
  }
  if (action === ArtifactBulkAction.ChangePriority) {
    assertDocumentRows(rows, action);
    if (!isPriority(value)) {
      throw new TypeError("Priority bulk action requires a priority");
    }
    return [
      {
        route: `${BatchMutationRoute.DocumentsUpdatePriority}/v2`,
        body: {
          documentIds: rows.map((row) => row.id),
          priority: value,
          surface: ArtifactStatusEditSurface.Bulk,
        },
        ids: rows.map((row) => row.id),
      },
    ];
  }
  if (action === ArtifactBulkAction.ChangeFavorite) {
    if (typeof value !== "boolean") {
      throw new TypeError(
        "Favorite bulk action requires a boolean target state"
      );
    }
    return [
      {
        route: BatchMutationRoute.ArtifactsFavorites,
        body: { artifactIds: rows.map((row) => row.id), favorite: value },
        ids: rows.map((row) => row.id),
      },
    ];
  }
  if (action === ArtifactBulkAction.ChangeOwner) {
    if (value !== null && typeof value !== "string") {
      throw new TypeError("Owner bulk action requires a user ID or null");
    }
    const documents = rows.filter(
      (row) =>
        row.kind === ArtifactBulkKind.Document ||
        row.kind === ArtifactBulkKind.Issue
    );
    const sessions = rows.filter(
      (row) => row.kind === ArtifactBulkKind.Session
    );
    return [
      ...(documents.length
        ? [
            {
              route: BatchMutationRoute.DocumentsUpdateAssignee,
              body: {
                documentIds: documents.map((row) => row.id),
                assigneeId: value,
              },
              ids: documents.map((row) => row.id),
            },
          ]
        : []),
      ...(sessions.length
        ? [
            {
              route: `${BatchMutationRoute.AgentSessionsAssign}/v2`,
              body: {
                sessionIds: sessions.map((row) => row.id),
                field: AgentSessionBulkAssignField.Owner,
                value,
              },
              ids: sessions.map((row) => row.id),
            },
          ]
        : []),
    ];
  }
  if (action === ArtifactBulkAction.ChangeProject) {
    return [sessionProjectRouteGroup(rows, value)];
  }
  throw new TypeError("This bulk action requires a host executor");
}

function sessionProjectRouteGroup(
  rows: readonly ArtifactBulkRow[],
  value: string | boolean | null
): RouteGroup {
  if (value !== null && typeof value !== "string") {
    throw new TypeError("Project bulk action requires a project ID or null");
  }
  if (!rows.every((row) => row.kind === ArtifactBulkKind.Session)) {
    throw new TypeError("This project bulk action requires Session rows");
  }
  const ids = rows.map((row) => row.id);
  return {
    route: `${BatchMutationRoute.AgentSessionsAssign}/v2`,
    body: {
      sessionIds: ids,
      field: AgentSessionBulkAssignField.Project,
      value,
    },
    ids,
  };
}

function hasSharedExecutor(
  action: ArtifactBulkActionValue,
  rows: readonly ArtifactBulkRow[],
  explicitlySupported = false
): boolean {
  if (rows.length === 0) {
    return (
      (explicitlySupported &&
        (action === ArtifactBulkAction.ChangeStatus ||
          action === ArtifactBulkAction.ChangePriority)) ||
      action === ArtifactBulkAction.ChangeFavorite ||
      action === ArtifactBulkAction.ChangeOwner
    );
  }
  if (
    action === ArtifactBulkAction.ChangeFavorite ||
    action === ArtifactBulkAction.ChangeOwner ||
    (action === ArtifactBulkAction.ChangeProject &&
      rows.every((row) => row.kind === ArtifactBulkKind.Session))
  ) {
    return true;
  }
  return (
    (action === ArtifactBulkAction.ChangeStatus ||
      action === ArtifactBulkAction.ChangePriority) &&
    rows.every(isDocumentRow)
  );
}

function assertDocumentRows(
  rows: readonly ArtifactBulkRow[],
  action: ArtifactBulkActionValue
): void {
  if (!rows.every(isDocumentRow)) {
    throw new TypeError(`${action} requires a document route executor`);
  }
}

function isDocumentRow(row: ArtifactBulkRow): boolean {
  return (
    row.kind === ArtifactBulkKind.Document ||
    row.kind === ArtifactBulkKind.Issue
  );
}
