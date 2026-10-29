/**
 * The receipts a bulk tag REMOVAL emits after it commits (ISS-10686).
 *
 * `__tests__/api/batch-remove-tag-v2.test.ts` proves the route CALLS this with
 * the ids the delete removed. This proves what it then writes — which audit
 * action, over which ids, under which transaction id — because a wiring test
 * that mocks this module cannot see an emitter that files a removal under
 * `artifact.tag_applied`.
 */
import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchAuditEvents: vi.fn(),
  captureBatchTagRemoved: vi.fn(),
  captureBatchTagApplied: vi.fn(),
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: mocks.dispatchAuditEvents,
  userAuditActor: (userId: string) => ({ actorId: userId }),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchTagRemoved: mocks.captureBatchTagRemoved,
  captureBatchTagApplied: mocks.captureBatchTagApplied,
}));

import {
  captureBatchTagActivity,
  emitBatchTagSideEffects,
} from "@/app/tags/batch-tag-side-effects";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222221";
const TAG_ID = "33333333-3333-4333-8333-333333333331";
const ARTIFACT_A = "55555555-5555-4555-8555-555555555551";
const ARTIFACT_B = "55555555-5555-4555-8555-555555555552";
const TRANSACTION_ID = "77777777-7777-4777-8777-777777777771";
const TX = {} as TransactionClient;

function sideEffectInput(removedIds: string[]) {
  return {
    user: { id: USER_ID, organizationId: ORG_ID },
    authMethod: "session" as const,
    action: AuditAction.ArtifactTagRemoved,
    tagId: TAG_ID,
    changedIds: removedIds,
    transactionId: TRANSACTION_ID,
  };
}

function emit(removedIds: string[]) {
  emitBatchTagSideEffects(sideEffectInput(removedIds));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emitBatchTagSideEffects removal arm (ISS-10686)", () => {
  it("files one artifact.tag_removed entry per untagged id, under the batch's transaction", async () => {
    emit([ARTIFACT_A, ARTIFACT_B]);

    expect(mocks.dispatchAuditEvents).toHaveBeenCalledTimes(1);
    const [events] = mocks.dispatchAuditEvents.mock.calls[0] as [
      Array<{
        action: string;
        objectId: string;
        objectType: string;
        detail: Record<string, unknown>;
      }>,
    ];
    expect(events.map((event) => event.objectId)).toEqual([
      ARTIFACT_A,
      ARTIFACT_B,
    ]);
    for (const event of events) {
      // Removed, never applied: the ledger is append-only, so an entry filed
      // under the wrong verb is a permanent lie about what happened.
      expect(event.action).toBe(AuditAction.ArtifactTagRemoved);
      expect(event.objectType).toBe(AuditObjectType.Artifact);
      expect(event.detail).toMatchObject({ tagId: TAG_ID });
      expect(event.detail.transactionId).toBe(TRANSACTION_ID);
    }
    await captureBatchTagActivity(
      TX,
      sideEffectInput([ARTIFACT_A, ARTIFACT_B])
    );
    expect(mocks.captureBatchTagRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: TX,
        organizationId: ORG_ID,
        tagId: TAG_ID,
        untaggedArtifactIds: [ARTIFACT_A, ARTIFACT_B],
        transactionId: TRANSACTION_ID,
      })
    );
    // The apply emitter is a different receipt for a different event; a removal
    // that also fired it would double-count the tag's history.
    expect(mocks.captureBatchTagApplied).not.toHaveBeenCalled();
  });

  it("emits nothing when the batch removed no rows", async () => {
    emit([]);
    await captureBatchTagActivity(TX, sideEffectInput([]));

    expect(mocks.dispatchAuditEvents).not.toHaveBeenCalled();
    expect(mocks.captureBatchTagRemoved).not.toHaveBeenCalled();
  });

  it("swallows a post-commit audit failure without weakening transactional activity", async () => {
    mocks.dispatchAuditEvents.mockImplementation(() => {
      throw new Error("outbox unavailable");
    });

    expect(() => emit([ARTIFACT_A])).not.toThrow();
    expect(mocks.captureBatchTagRemoved).not.toHaveBeenCalled();

    mocks.captureBatchTagRemoved.mockResolvedValue(undefined);
    await expect(
      captureBatchTagActivity(TX, sideEffectInput([ARTIFACT_A]))
    ).resolves.toBeUndefined();
  });
});
