/**
 * ISS-10458 — an undo's receipts name the bulk mutation they reverse.
 *
 * Entered at the ROUTE and run through the REAL `emitBatchStatusSideEffects`,
 * with only the domain service, the audit outbox, the activity store and the
 * unblock sweep faked. The contract is the wiring: a unit test of the emitter
 * alone would stay green if the route stopped reading the field off the body.
 *
 * BOTH routes, deliberately. `/v1` is the one the undo registry's inverse
 * actually targets and `/v2` is the one that hands a client the id to name in
 * the first place, so a fixture over either alone cannot tell a shared
 * validator-and-emitter path from one route that learned the field.
 */
import { AuditActorType } from "@repo/api/src/types/audit";
import { batchItemApplied } from "@repo/api/src/types/batch-mutation-result";
import { IssueStatus } from "@repo/api/src/types/document";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import {
  isUndoableCommand,
  type UndoCommandContext,
  UndoEntityType,
  UndoMutationKind,
} from "@repo/api/src/types/undo-command";
import { undoRegistryEntryFor } from "@repo/api/src/types/undo-command-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mocks = vi.hoisted(() => ({
  batchUpdateStatusPerItem: vi.fn(),
  batchUpdateStatus: vi.fn(),
  dispatchAuditEvents: vi.fn(),
  captureBatchStatusChange: vi.fn(),
  resolveBlocksForChangedArtifacts: vi.fn(),
  /**
   * The receipts the undo reference resolves against. TWO organizations, not
   * one: the guard's whole job is that a real transaction id belonging to
   * another tenant resolves to nothing, and a single-org fixture cannot tell an
   * org-scoped query from an unscoped one (both answer the same on every row).
   */
  activityEventRows: [] as Array<{
    organizationId: string;
    transactionId: string;
  }>,
}));

/**
 * Prisma's own `where` semantics, which is what makes the cross-tenant case
 * load-bearing: an ABSENT key is unconstrained, so dropping `organizationId`
 * from the production query makes another org's row match on the transaction id
 * alone — the exact mutation the cross-tenant assertion exists to kill. A filter
 * that instead required equality against `undefined` would fail the happy path
 * too and hide which one broke.
 */
vi.mock("@repo/database", async (importOriginal) => {
  const run = <T>(fn: (client: unknown) => T): T =>
    fn({
      artifactActivityEvent: {
        findFirst: ({
          where,
        }: {
          where: { organizationId?: string; transactionId?: string };
        }) =>
          Promise.resolve(
            mocks.activityEventRows.find(
              (row) =>
                (where.organizationId === undefined ||
                  row.organizationId === where.organizationId) &&
                (where.transactionId === undefined ||
                  row.transactionId === where.transactionId)
            ) ?? null
          ),
      },
    });
  return {
    ...(await importOriginal<object>()),
    withDb: Object.assign(run, { tx: run }),
  };
});

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: (...args: unknown[]) => Promise<Response>) => {
    return (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params);
  },
}));
vi.mock("@/app/documents/document-status-batch-item-service", () => ({
  documentStatusBatchItemService: {
    batchUpdateStatus: mocks.batchUpdateStatusPerItem,
  },
}));
// PARTIAL: `validateUndoTransactionReference` stays REAL, so the refusals below
// are the production guard's, not a stub's. Only the write is faked.
vi.mock(
  "@/app/documents/document-status-mutation-service",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    documentStatusMutationService: {
      batchUpdateStatus: mocks.batchUpdateStatus,
    },
  })
);
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: (...args: unknown[]) =>
    mocks.dispatchAuditEvents(...args),
  userAuditActor: (userId: string) => ({
    actorType: AuditActorType.User,
    actorId: userId,
  }),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchStatusChange: (...args: unknown[]) =>
    mocks.captureBatchStatusChange(...args),
}));
vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    resolveBlocksForChangedArtifacts: (...args: unknown[]) =>
      mocks.resolveBlocksForChangedArtifacts(...args),
  },
}));

import { POST as updateStatus } from "@/app/documents/batch-update-status/route";
import { POST as updateStatusV2 } from "@/app/documents/batch-update-status/v2/route";
import { batchUpdateStatusValidator } from "@/app/documents/validators";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const DOC_C = "44444444-4444-4444-8444-444444444444";
/**
 * A literal, never `newBulkTransactionId()`: this value stands in for one a
 * PREVIOUS request minted and the client sent back, so deriving it from the
 * same helper the route uses would let a route that quietly re-minted its own
 * id still satisfy the assertion.
 */
const FORWARD_TRANSACTION_ID = "55555555-5555-4555-8555-555555555555";
/** `createTestAuthContext`'s organization — the caller's, on every request. */
const CALLER_ORG = "test-org-id";
const OTHER_ORG = "other-org-id";
/**
 * Well-formed, and named by NO receipt in either organization: the shape a
 * caller can type by hand, which `z.uuid()` alone cannot tell from a real one.
 */
const UNKNOWN_TRANSACTION_ID = "66666666-6666-4666-8666-666666666666";
/**
 * Real, and another tenant's — the id a caller lifts off a `/v2` response they
 * were shown. It resolves to a row; it must not resolve for THIS caller.
 */
const FOREIGN_TRANSACTION_ID = "77777777-7777-4777-8777-777777777777";

type AuditEmission = {
  objectId: string;
  detail: { transactionId: string; undoOfTransactionId?: string };
};

function emittedAuditEvents(): AuditEmission[] {
  return mocks.dispatchAuditEvents.mock.calls[0][0] as AuditEmission[];
}

function statusRequest(
  path: string,
  documentIds: string[],
  body: Record<string, unknown>
) {
  return createMockRequest({
    url: `http://localhost:3002${path}`,
    method: "POST",
    body: { documentIds, status: IssueStatus.Done, ...body },
  });
}

/** `changedIds` is the COMMITTED subset; `documentIds` is what was requested. */
function serviceReturns(documentIds: string[], changedIds: string[]) {
  const transitions = changedIds.map((documentId) => ({
    documentId,
    before: IssueStatus.Todo,
    after: IssueStatus.Done,
  }));
  mocks.batchUpdateStatusPerItem.mockResolvedValue({
    resultsById: new Map(
      documentIds.map((id) => [id, batchItemApplied(id)] as const)
    ),
    changedIds,
    transitions,
  });
  mocks.batchUpdateStatus.mockResolvedValue({
    ok: true,
    value: { updatedIds: changedIds, changedIds, transitions },
  });
}

async function runV2(
  documentIds: string[],
  changedIds: string[],
  body: Record<string, unknown> = {}
) {
  serviceReturns(documentIds, changedIds);
  const response = await updateStatusV2(
    statusRequest("/documents/batch-update-status/v2", documentIds, body),
    createMockRouteContext({})
  );
  return response;
}

async function runV1(
  documentIds: string[],
  changedIds: string[],
  body: Record<string, unknown> = {}
) {
  serviceReturns(documentIds, changedIds);
  return await updateStatus(
    statusRequest("/documents/batch-update-status", documentIds, body),
    createMockRouteContext({})
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mocks.resolveBlocksForChangedArtifacts.mockResolvedValue(undefined);
  mocks.activityEventRows = [
    { organizationId: CALLER_ORG, transactionId: FORWARD_TRANSACTION_ID },
    { organizationId: OTHER_ORG, transactionId: FOREIGN_TRANSACTION_ID },
  ];
});

describe("an undo names the bulk mutation it reverses (ISS-10458)", () => {
  it("stamps the reversed transaction on every ledger entry and on the receipt", async () => {
    await runV2([DOC_A, DOC_B], [DOC_A, DOC_B], {
      undoOfTransactionId: FORWARD_TRANSACTION_ID,
    });

    const emitted = emittedAuditEvents();
    expect(emitted).toHaveLength(2);
    for (const event of emitted) {
      expect(event.detail.undoOfTransactionId).toBe(FORWARD_TRANSACTION_ID);
    }
    expect(mocks.captureBatchStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ undoOfTransactionId: FORWARD_TRANSACTION_ID })
    );
  });

  it("keeps the undo's OWN identity distinct from the one it reverses", async () => {
    // The two answer different questions — which commit wrote this row, and
    // which commit it undid — so one id serving as both would say the pair is
    // a single action while still not saying which half reversed the other.
    await runV2([DOC_A], [DOC_A], {
      undoOfTransactionId: FORWARD_TRANSACTION_ID,
    });

    const { detail } = emittedAuditEvents()[0];
    expect(detail.transactionId).toEqual(expect.any(String));
    expect(detail.transactionId).not.toBe(FORWARD_TRANSACTION_ID);
    expect(mocks.captureBatchStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: detail.transactionId })
    );
  });

  it("traces a PARTIAL undo: only the restored rows get receipts, all naming the forward", async () => {
    // The partial-run case the ticket names. The undo asked for three rows and
    // the server moved two, so an id that lived on the REQUEST rather than on
    // the committed receipts would either claim a row that never moved or go
    // missing from the rows that did.
    await runV2([DOC_A, DOC_B, DOC_C], [DOC_A, DOC_C], {
      undoOfTransactionId: FORWARD_TRANSACTION_ID,
    });

    const emitted = emittedAuditEvents();
    expect(emitted.map((event) => event.objectId)).toEqual([DOC_A, DOC_C]);
    expect(
      new Set(emitted.map((event) => event.detail.undoOfTransactionId))
    ).toEqual(new Set([FORWARD_TRANSACTION_ID]));
    expect(mocks.captureBatchStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({
        undoOfTransactionId: FORWARD_TRANSACTION_ID,
        changes: [
          {
            artifactId: DOC_A,
            before: IssueStatus.Todo,
            after: IssueStatus.Done,
          },
          {
            artifactId: DOC_C,
            before: IssueStatus.Todo,
            after: IssueStatus.Done,
          },
        ],
      })
    );
  });

  it("OMITS the key entirely for a batch that is not an undo", async () => {
    // Omission, not `null`: the detail is hashed into an append-only chain, so
    // a key written once is there for the life of the row.
    await runV2([DOC_A], [DOC_A]);

    const { detail } = emittedAuditEvents()[0];
    expect(Object.hasOwn(detail, "undoOfTransactionId")).toBe(false);
    expect(mocks.captureBatchStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ undoOfTransactionId: undefined })
    );
  });

  it("stamps the reference on the v1 route the inverse actually targets", async () => {
    await runV1([DOC_A], [DOC_A], {
      undoOfTransactionId: FORWARD_TRANSACTION_ID,
    });

    expect(emittedAuditEvents()[0].detail.undoOfTransactionId).toBe(
      FORWARD_TRANSACTION_ID
    );
  });

  it("refuses a reference that is not a minted transaction id, before the write", async () => {
    const response = await runV2([DOC_A], [DOC_A], {
      undoOfTransactionId: "the-batch-before-this-one",
    });

    expect(response.status).toBe(400);
    expect(mocks.batchUpdateStatusPerItem).not.toHaveBeenCalled();
    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
  });
});

/**
 * ISS-10458 review (tamsinb, whitlockk). `z.uuid()` proves only SHAPE, so before
 * this guard any write-scoped caller could name a transaction that never
 * existed — or one belonging to another tenant — and the receipt would assert
 * "this undid X" for the life of a hash chain that cannot be corrected.
 *
 * Resolution is against `ArtifactActivityEvent`, which ISS-10993 made a sound
 * oracle by committing capture inside the mutation's own transaction.
 */
describe("an undo may only name a transaction this organization committed", () => {
  it("refuses a well-formed UUID that names no transaction at all", async () => {
    const response = await runV2([DOC_A], [DOC_A], {
      undoOfTransactionId: UNKNOWN_TRANSACTION_ID,
    });

    expect(response.status).toBe(400);
    expect(mocks.batchUpdateStatusPerItem).not.toHaveBeenCalled();
    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
    expect(mocks.captureBatchStatusChange).not.toHaveBeenCalled();
  });

  it("refuses a REAL transaction id belonging to another organization", async () => {
    // The cross-tenant half, and the one a single-org fixture cannot reach:
    // this id resolves to a row, so an unscoped lookup would ACCEPT it. The
    // control below proves the refusal is the org and not the id's absence.
    expect(
      mocks.activityEventRows.some(
        (row) => row.transactionId === FOREIGN_TRANSACTION_ID
      )
    ).toBe(true);

    const response = await runV2([DOC_A], [DOC_A], {
      undoOfTransactionId: FOREIGN_TRANSACTION_ID,
    });

    expect(response.status).toBe(400);
    expect(mocks.batchUpdateStatusPerItem).not.toHaveBeenCalled();
    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
    expect(mocks.captureBatchStatusChange).not.toHaveBeenCalled();
  });

  it("names the field it refused, so a caller can tell which id was bad", async () => {
    const response = await runV2([DOC_A], [DOC_A], {
      undoOfTransactionId: UNKNOWN_TRANSACTION_ID,
    });
    const body = await response.json();

    expect(body.code).toBe(DocumentStatusMutationErrorCode.InvalidReference);
    expect(body.details).toMatchObject({
      field: "undoOfTransactionId",
      id: UNKNOWN_TRANSACTION_ID,
    });
  });

  it("commits an undo naming a transaction THIS organization committed", async () => {
    // The counterfactual for all three refusals above: same route, same body
    // shape, only the id's owner differs.
    const response = await runV2([DOC_A], [DOC_A], {
      undoOfTransactionId: FORWARD_TRANSACTION_ID,
    });

    expect(response.status).toBe(200);
    expect(mocks.batchUpdateStatusPerItem).toHaveBeenCalled();
    expect(mocks.captureBatchStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ undoOfTransactionId: FORWARD_TRANSACTION_ID })
    );
  });

  it("refuses on the v1 route too, which is the one the inverse targets", async () => {
    const response = await runV1([DOC_A], [DOC_A], {
      undoOfTransactionId: FOREIGN_TRANSACTION_ID,
    });

    expect(response.status).toBe(400);
    expect(mocks.batchUpdateStatus).not.toHaveBeenCalled();
    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
  });
});

/**
 * The registry lives in `@repo/api` and the validator in `apps/api`, so the
 * field name is written twice. Nothing but this makes them agree — and the
 * validator is `.strict()`, so a rename on either side does not degrade the
 * reference, it 400s the whole undo.
 */
describe("the registry's inverse is a body this route accepts", () => {
  it("parses the bulk-status inverse body, reference and all", () => {
    const entry = undoRegistryEntryFor(
      UndoMutationKind.ArtifactBulkStatusChange
    );
    if (!isUndoableCommand(entry)) {
      throw new Error("artifact_bulk_status_change is not declared undoable");
    }
    const context: UndoCommandContext = {
      entity: { type: UndoEntityType.Artifact, ids: [DOC_A] },
      priorValue: { [DOC_A]: IssueStatus.Todo },
      newValue: { [DOC_A]: IssueStatus.Done },
      forwardTransactionId: FORWARD_TRANSACTION_ID,
    };

    for (const call of entry.inverse(context)) {
      const parsed = batchUpdateStatusValidator.safeParse(call.body);
      expect(parsed.error?.message).toBeUndefined();
      expect(parsed.data?.undoOfTransactionId).toBe(FORWARD_TRANSACTION_ID);
    }
  });
});
