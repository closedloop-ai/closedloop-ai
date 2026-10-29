import { AgentSessionBulkAssignField } from "@repo/api/src/types/agent-session-bulk-assign";
import {
  ArtifactBulkAction,
  ArtifactBulkKind,
} from "@repo/api/src/types/artifact-bulk-action";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  BatchItemFailureCode,
  batchItemApplied,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactBulkActionEntry,
  type ArtifactBulkExecutor,
  type ArtifactBulkRow,
  createArtifactBulkActionRegistry,
  executeSharedArtifactBulkAction,
} from "./registry";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_DOCUMENT_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const BRANCH_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";

const mixedRows: ArtifactBulkRow[] = [
  { id: SESSION_ID, kind: ArtifactBulkKind.Session },
  { id: DOCUMENT_ID, kind: ArtifactBulkKind.Document },
];

describe("shared artifact bulk action registry", () => {
  it("routes Session project assignment through v2 and excludes system status", async () => {
    const post = vi.fn().mockResolvedValue({
      results: [batchItemApplied(SESSION_ID)],
      transactionId: "session-project-transaction",
    });
    const rows: ArtifactBulkRow[] = [
      { id: SESSION_ID, kind: ArtifactBulkKind.Session },
    ];
    const entries = createArtifactBulkActionRegistry({ rows, host: { post } });
    expect(entries.map((entry) => entry.id)).toContain(
      ArtifactBulkAction.ChangeProject
    );
    expect(entries.map((entry) => entry.id)).not.toContain(
      ArtifactBulkAction.ChangeStatus
    );
    const move = entries.find(
      (entry) => entry.id === ArtifactBulkAction.ChangeProject
    );
    await expect(move?.execute(OWNER_ID)).resolves.toEqual({
      results: [batchItemApplied(SESSION_ID)],
      transactionIds: ["session-project-transaction"],
    });
    expect(post).toHaveBeenCalledWith(
      `${BatchMutationRoute.AgentSessionsAssign}/v2`,
      {
        sessionIds: [SESSION_ID],
        field: AgentSessionBulkAssignField.Project,
        value: OWNER_ID,
      }
    );
  });
  it("keeps every canonical action available to a document host executor", () => {
    const executor = vi.fn(() =>
      Promise.resolve({
        results: [batchItemApplied(DOCUMENT_ID)],
        transactionIds: [],
      })
    );
    const executors = Object.fromEntries(
      Object.values(ArtifactBulkAction).map((action) => [action, executor])
    );
    const entries = createArtifactBulkActionRegistry({
      rows: [{ id: DOCUMENT_ID, kind: ArtifactBulkKind.Document }],
      host: { post: vi.fn(), executors },
    });
    expect(entries.map((entry) => entry.id).sort()).toEqual(
      Object.values(ArtifactBulkAction).sort()
    );
  });

  it.each(Object.values(ArtifactBulkAction))(
    "preserves per-item outcomes for %s",
    async (action) => {
      const rows: ArtifactBulkRow[] = [
        { id: DOCUMENT_ID, kind: ArtifactBulkKind.Document },
        { id: SECOND_DOCUMENT_ID, kind: ArtifactBulkKind.Document },
      ];
      const executor: ArtifactBulkExecutor = vi.fn().mockResolvedValue({
        results: [
          batchItemApplied(DOCUMENT_ID),
          batchItemFailed(
            SECOND_DOCUMENT_ID,
            BatchItemFailureCode.ArtifactsNotFound
          ),
        ],
        transactionIds: ["action-transaction"],
      });
      const entry = createArtifactBulkActionRegistry({
        rows,
        host: { post: vi.fn(), executors: { [action]: executor } },
      }).find((candidate) => candidate.id === action);

      await expect(entry?.execute(null)).resolves.toEqual({
        results: [
          batchItemApplied(DOCUMENT_ID),
          batchItemFailed(
            SECOND_DOCUMENT_ID,
            BatchItemFailureCode.ArtifactsNotFound
          ),
        ],
        transactionIds: ["action-transaction"],
      });
      expect(executor).toHaveBeenCalledWith(rows, null);
    }
  );

  it("keeps page-supported actions for a mixed selection and preserves extras", () => {
    const extra: ArtifactBulkActionEntry = {
      id: "host-extra",
      supportedIds: [SESSION_ID, DOCUMENT_ID],
      execute: vi.fn(),
    };
    const entries = createArtifactBulkActionRegistry({
      rows: mixedRows,
      host: { post: vi.fn() },
      extras: [extra],
    });
    expect(entries.map((entry) => entry.id)).toContain(
      ArtifactBulkAction.ChangeOwner
    );
    expect(entries.map((entry) => entry.id)).toContain(
      ArtifactBulkAction.ChangeFavorite
    );
    expect(entries.map((entry) => entry.id)).toContain(
      ArtifactBulkAction.ChangeStatus
    );
    expect(entries.at(-1)).toBe(extra);
  });

  it("keeps page-supported status and owner visible for an all-Branch selection", () => {
    const rows: ArtifactBulkRow[] = [
      {
        id: BRANCH_ID,
        kind: ArtifactBulkKind.Branch,
        label: "TEST ONLY: Branch",
      },
    ];
    const post = vi.fn();
    const entries = createArtifactBulkActionRegistry({
      rows,
      host: {
        post,
        pageKinds: [ArtifactBulkKind.Document, ArtifactBulkKind.Branch],
      },
    });
    expect(entries.map((entry) => entry.id)).toContain(
      ArtifactBulkAction.ChangeStatus
    );
    expect(entries.map((entry) => entry.id)).toContain(
      ArtifactBulkAction.ChangeOwner
    );
    expect(entries.map((entry) => entry.id)).not.toContain(
      ArtifactBulkAction.ChangeProject
    );
    for (const entry of entries.filter(
      (candidate) =>
        candidate.id === ArtifactBulkAction.ChangeStatus ||
        candidate.id === ArtifactBulkAction.ChangeOwner
    )) {
      expect(entry.partition).toEqual({
        selectedRows: rows,
        applicableRows: [],
        inapplicableRows: rows,
      });
      expect(() => entry.execute(null)).toThrow(RangeError);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("partitions a non-editable Document without hiding page-supported Status", () => {
    const row: ArtifactBulkRow = {
      id: DOCUMENT_ID,
      kind: ArtifactBulkKind.Document,
      label: "TEST ONLY: Restricted document",
    };
    const entries = createArtifactBulkActionRegistry({
      rows: [row],
      host: {
        post: vi.fn(),
        pageKinds: [ArtifactBulkKind.Document],
        canApply: (action) => action !== ArtifactBulkAction.ChangeStatus,
      },
    });
    const status = entries.find(
      (entry) => entry.id === ArtifactBulkAction.ChangeStatus
    );
    expect(status?.partition).toEqual({
      selectedRows: [row],
      applicableRows: [],
      inapplicableRows: [row],
    });
  });

  it.each([
    {
      action: ArtifactBulkAction.ChangeStatus,
      route: `${BatchMutationRoute.DocumentsUpdateStatus}/v2`,
      value: DocumentStatus.Approved,
      body: {
        documentIds: [DOCUMENT_ID, SECOND_DOCUMENT_ID],
        status: DocumentStatus.Approved,
        surface: ArtifactStatusEditSurface.Bulk,
      },
    },
    {
      action: ArtifactBulkAction.ChangePriority,
      route: `${BatchMutationRoute.DocumentsUpdatePriority}/v2`,
      value: Priority.High,
      body: {
        documentIds: [DOCUMENT_ID, SECOND_DOCUMENT_ID],
        priority: Priority.High,
        surface: ArtifactStatusEditSurface.Bulk,
      },
    },
  ])("executes $action through its v2 route", async (fixture) => {
    const response = {
      results: [
        batchItemApplied(DOCUMENT_ID),
        batchItemFailed(
          SECOND_DOCUMENT_ID,
          BatchItemFailureCode.ArtifactsNotFound
        ),
      ],
      transactionId: "field-transaction",
    };
    const post = vi.fn().mockResolvedValue(response);
    const rows: ArtifactBulkRow[] = [
      { id: DOCUMENT_ID, kind: ArtifactBulkKind.Document },
      { id: SECOND_DOCUMENT_ID, kind: ArtifactBulkKind.Document },
    ];
    const entry = createArtifactBulkActionRegistry({
      rows,
      host: { post },
    }).find((candidate) => candidate.id === fixture.action);

    await expect(entry?.execute(fixture.value)).resolves.toEqual({
      results: response.results,
      transactionIds: ["field-transaction"],
    });
    expect(post).toHaveBeenCalledWith(fixture.route, fixture.body);
  });

  it("partitions owner for a document and branch, then routes only the document", async () => {
    const post = vi.fn().mockResolvedValue({
      results: [batchItemApplied(DOCUMENT_ID)],
      transactionId: "document-owner-transaction",
    });
    const rows: ArtifactBulkRow[] = [
      { id: DOCUMENT_ID, kind: ArtifactBulkKind.Document },
      { id: BRANCH_ID, kind: ArtifactBulkKind.Branch },
    ];
    const entries = createArtifactBulkActionRegistry({ rows, host: { post } });
    const owner = entries.find(
      (entry) => entry.id === ArtifactBulkAction.ChangeOwner
    );
    expect(owner?.partition).toEqual({
      selectedRows: rows,
      applicableRows: [rows[0]],
      inapplicableRows: [rows[1]],
    });
    expect(owner?.supportedIds).toEqual([DOCUMENT_ID]);
    expect(entries.map((entry) => entry.id)).toContain(
      ArtifactBulkAction.ChangeFavorite
    );
    await expect(owner?.execute(OWNER_ID)).resolves.toEqual({
      results: [batchItemApplied(DOCUMENT_ID)],
      transactionIds: ["document-owner-transaction"],
    });
    expect(post).toHaveBeenCalledWith(
      BatchMutationRoute.DocumentsUpdateAssignee,
      { documentIds: [DOCUMENT_ID], assigneeId: OWNER_ID }
    );
    await expect(
      executeSharedArtifactBulkAction(
        { post },
        ArtifactBulkAction.ChangeOwner,
        rows,
        OWNER_ID
      )
    ).rejects.toThrow("not valid for every selected row");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("passes only applicable rows to a host executor for a mixed project move", async () => {
    const executor = vi.fn().mockResolvedValue({
      results: [batchItemApplied(DOCUMENT_ID)],
      transactionIds: [],
    });
    const rows: ArtifactBulkRow[] = [
      { id: DOCUMENT_ID, kind: ArtifactBulkKind.Document },
      { id: OWNER_ID, kind: ArtifactBulkKind.Project },
    ];
    const entry = createArtifactBulkActionRegistry({
      rows,
      host: {
        post: vi.fn(),
        executors: { [ArtifactBulkAction.ChangeProject]: executor },
      },
    }).find((candidate) => candidate.id === ArtifactBulkAction.ChangeProject);

    expect(entry?.partition).toEqual({
      selectedRows: rows,
      applicableRows: [rows[0]],
      inapplicableRows: [rows[1]],
    });
    await entry?.execute(SESSION_ID);
    expect(executor).toHaveBeenCalledWith([rows[0]], SESSION_ID);
  });

  it("merges ordered per-item outcomes and both receipts across two owner routes", async () => {
    const post = vi.fn((route: string) => {
      if (route === BatchMutationRoute.DocumentsUpdateAssignee) {
        return Promise.resolve({
          results: [
            batchItemFailed(
              DOCUMENT_ID,
              BatchItemFailureCode.ArtifactsNotFound
            ),
          ],
          transactionId: "document-transaction",
        });
      }
      return Promise.resolve({
        results: [batchItemApplied(SESSION_ID)],
        transactionId: "session-transaction",
      });
    });
    const entries = createArtifactBulkActionRegistry({
      rows: mixedRows,
      host: { post },
    });
    const owner = entries.find(
      (entry) => entry.id === ArtifactBulkAction.ChangeOwner
    );
    expect(owner).toBeDefined();
    const result = await owner?.execute(OWNER_ID);

    expect(post).toHaveBeenCalledWith(
      BatchMutationRoute.DocumentsUpdateAssignee,
      { documentIds: [DOCUMENT_ID], assigneeId: OWNER_ID }
    );
    expect(post).toHaveBeenCalledWith(
      `${BatchMutationRoute.AgentSessionsAssign}/v2`,
      {
        sessionIds: [SESSION_ID],
        field: AgentSessionBulkAssignField.Owner,
        value: OWNER_ID,
      }
    );
    expect(result).toEqual({
      results: [
        batchItemApplied(SESSION_ID),
        batchItemFailed(DOCUMENT_ID, BatchItemFailureCode.ArtifactsNotFound),
      ],
      transactionIds: ["document-transaction", "session-transaction"],
    });
  });

  it("keeps fulfilled results and receipts when a sibling route rejects", async () => {
    const post = vi.fn((route: string) => {
      if (route === BatchMutationRoute.DocumentsUpdateAssignee) {
        return Promise.resolve({
          results: [batchItemApplied(DOCUMENT_ID)],
          transactionId: "document-transaction",
        });
      }
      return Promise.reject(new Error("session route unavailable"));
    });

    await expect(
      executeSharedArtifactBulkAction(
        { post },
        ArtifactBulkAction.ChangeOwner,
        mixedRows,
        OWNER_ID
      )
    ).resolves.toEqual({
      results: [
        batchItemFailed(SESSION_ID, BatchItemFailureCode.OutcomeUnknown),
        batchItemApplied(DOCUMENT_ID),
      ],
      transactionIds: ["document-transaction"],
    });
  });
});
