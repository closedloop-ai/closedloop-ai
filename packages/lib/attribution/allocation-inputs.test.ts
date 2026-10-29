import { ACTIVITY_PHASE } from "@repo/api/src/types/activity-phase";
import {
  AttributionRelationshipKind,
  UsageAssociationMethod,
  UsageTokenCategory,
} from "@repo/api/src/types/attribution-evidence";
import {
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { describe, expect, it } from "vitest";
import {
  allocateUsage,
  ReconciliationFailureKind,
} from "../allocation/allocate-usage";
import { claudeTranscriptEntryUuidScheme } from "../harness/usage-dedup";
import {
  type AllocationEvidence,
  type AllocationUsageEvent,
  branchRecipientsByName,
  claimRequestAnchors,
  crossSessionSourceKey,
  recipientsAndOperations,
  sessionCopySourceKey,
  usageObservations,
  withoutUsageOwnedElsewhere,
} from "./allocation-inputs";
import {
  associateUsageWithReasons,
  UnprovenUsageReason,
  UsageOperationClass,
} from "./associate-usage";

const AT = new Date("2026-10-16T12:00:00.000Z");

function event(
  extra: Partial<AllocationUsageEvent> = {}
): AllocationUsageEvent {
  return {
    externalEventId: "evt-1",
    agentExternalId: null,
    model: "claude-sonnet-4-20250514",
    inputTokens: 100n,
    outputTokens: 50n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "claude-message",
      sourceRecordIds: ["msg_01"],
    },
    eventCreatedAt: AT,
    ...extra,
  };
}

function evidence(extra: Partial<AllocationEvidence> = {}): AllocationEvidence {
  return {
    targetArtifactId: "doc-1",
    relationshipKind: AttributionRelationshipKind.Creation,
    agentId: null,
    invokedAt: AT,
    effectiveAt: null,
    receiptId: null,
    anchors: {},
    ...extra,
  };
}

describe("usageObservations", () => {
  it("emits one unit per non-zero category, keyed by the usage source identity", () => {
    expect(usageObservations([event()])).toEqual([
      expect.objectContaining({
        sourceKey: `claude-message:msg_01#${UsageTokenCategory.Input}`,
        category: UsageTokenCategory.Input,
        tokens: 100,
        atMs: AT.getTime(),
      }),
      expect.objectContaining({
        sourceKey: `claude-message:msg_01#${UsageTokenCategory.Output}`,
        tokens: 50,
      }),
    ]);
  });

  it("makes two stored rows of one source usage a duplicate source (ISS-8035)", () => {
    const units = usageObservations([
      event(),
      event({ externalEventId: "evt-1-copy" }),
    ]);

    const result = allocateUsage({ units, recipients: [], provenBy: [] });

    expect(!result.ok && result.error.kind).toBe(
      ReconciliationFailureKind.DuplicateSource
    );
  });

  it("falls back to the event id when the source identity is unavailable", () => {
    const [unit] = usageObservations([
      event({
        externalEventId: "evt-9",
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Unavailable,
          reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
        },
      }),
    ]);

    expect(unit?.sourceKey).toBe(`event:evt-9#${UsageTokenCategory.Input}`);
  });
});

describe("recipientsAndOperations", () => {
  it("takes writing and implementation, never comments or reads, one recipient per artifact", () => {
    const { recipients, operations } = recipientsAndOperations([
      evidence(),
      evidence({ relationshipKind: AttributionRelationshipKind.Revision }),
      evidence({
        targetArtifactId: "branch-1",
        relationshipKind: AttributionRelationshipKind.Implementation,
        invokedAt: null,
      }),
      evidence({
        targetArtifactId: "doc-2",
        relationshipKind: AttributionRelationshipKind.CommentReview,
      }),
      evidence({
        targetArtifactId: "doc-3",
        relationshipKind: AttributionRelationshipKind.Usage,
      }),
    ]);

    expect(recipients).toEqual(["doc-1", "branch-1"]);
    expect(operations).toEqual([
      expect.objectContaining({ operationClass: UsageOperationClass.Plan }),
      expect.objectContaining({ operationClass: UsageOperationClass.Plan }),
      {
        recipientKey: "branch-1",
        operationClass: UsageOperationClass.Implementation,
        agentId: null,
        atMs: null,
        requestKey: null,
      },
    ]);
  });
});

describe("branchRecipientsByName", () => {
  it("resolves a branch name only when it names one implemented branch", () => {
    const implementation = (id: string, headRef: string) =>
      evidence({
        targetArtifactId: id,
        relationshipKind: AttributionRelationshipKind.Implementation,
        anchors: { repositoryOutput: { repository: "acme/app", headRef } },
      });

    expect(
      branchRecipientsByName([
        implementation("branch-1", "feat/x"),
        implementation("branch-2", "main"),
        implementation("branch-3", "main"),
      ])
    ).toEqual(new Map([["feat/x", "branch-1"]]));
  });
});

describe("withoutUsageOwnedElsewhere (ISS-12552 AC-020)", () => {
  const claude = (externalEventId: string, uuid: string) =>
    event({
      externalEventId,
      sourceIdentity: {
        availability: TokenSourceIdentityAvailability.Available,
        scheme: claudeTranscriptEntryUuidScheme,
        sourceRecordIds: [uuid],
      },
    });
  const otherScheme = event({
    externalEventId: "other-L12",
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "other.transcript.line",
      sourceRecordIds: ["L12"],
    },
  });

  it("keys only a Claude transcript entry uuid across sessions", () => {
    expect(crossSessionSourceKey(claude("a", "uuid-a").sourceIdentity)).toBe(
      `${claudeTranscriptEntryUuidScheme}:uuid-a`
    );
    expect(crossSessionSourceKey(otherScheme.sourceIdentity)).toBeNull();
    expect(
      crossSessionSourceKey({
        availability: TokenSourceIdentityAvailability.Unavailable,
        reason: TokenSourceIdentityUnavailableReason.MissingSourceRecordId,
      })
    ).toBeNull();
    expect(crossSessionSourceKey(null)).toBeNull();
  });

  it("drops a copied event another session owns and keeps the session's own", () => {
    const copied = claude("copied", "uuid-parent");
    const own = claude("own", "uuid-fork");

    expect(
      withoutUsageOwnedElsewhere(
        [copied, own, otherScheme],
        new Set([
          crossSessionSourceKey(copied.sourceIdentity) ?? "",
          "other.transcript.line:L12",
        ])
      )
    ).toEqual([own, otherScheme]);
  });

  it("keys a copy of the session by its event id, whatever identity it carries", () => {
    const legacy = event({
      externalEventId: "token-event-abc",
      sourceIdentity: {
        availability: TokenSourceIdentityAvailability.Unavailable,
        reason: TokenSourceIdentityUnavailableReason.LegacyRecord,
      },
    });
    const own = claude("own", "uuid-own");

    expect(sessionCopySourceKey(otherScheme)).toBe("event:other-L12");
    expect(sessionCopySourceKey(legacy)).toBe("event:token-event-abc");
    expect(
      withoutUsageOwnedElsewhere(
        [otherScheme, legacy, own],
        new Set([
          sessionCopySourceKey(otherScheme),
          sessionCopySourceKey(legacy),
        ])
      )
    ).toEqual([own]);
  });
});

describe("request keys", () => {
  it("gives each unit every source record of its request, scheme-qualified", () => {
    const units = usageObservations([event()]);

    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      expect(unit.requestKeys).toEqual(["claude-message:msg_01"]);
    }
  });

  it("joins an operation by request only when a receipt committed it", () => {
    const anchors = { requestKey: "claude-message:msg_01" };
    const { operations } = recipientsAndOperations([
      evidence({ receiptId: "receipt-1", anchors }),
      evidence({ targetArtifactId: "doc-2", anchors }),
    ]);

    expect(operations.map((operation) => operation.requestKey)).toEqual([
      "claude-message:msg_01",
      null,
    ]);
  });
});

describe("write-to-commit join", () => {
  const implementation = (anchors: unknown) =>
    evidence({
      targetArtifactId: "branch-1",
      relationshipKind: AttributionRelationshipKind.Implementation,
      invokedAt: null,
      anchors,
    });

  it("gives a joined implementation row one operation per request and none on the fallback", () => {
    const { recipients, operations } = recipientsAndOperations([
      implementation({ requestKeys: ["req-a", "req-b"] }),
    ]);

    expect(recipients).toEqual(["branch-1"]);
    expect(operations.map((operation) => operation.requestKey)).toEqual([
      "req-a",
      "req-b",
    ]);
  });

  it("keeps a branch whose join placed no request a recipient with no operation", () => {
    const { recipients, operations } = recipientsAndOperations([
      implementation({ requestKeys: [] }),
    ]);

    expect(recipients).toEqual(["branch-1"]);
    expect(operations).toEqual([]);
  });

  it("leaves an older Desktop's row, which names no join, on the fallback", () => {
    const { operations } = recipientsAndOperations([
      implementation({ repositoryOutput: { headRef: "feat/x" } }),
    ]);

    expect(operations.map((operation) => operation.requestKey)).toEqual([null]);
  });

  it("proves a joined request for its branch, and a request that also wrote a document for neither", () => {
    const units = [
      ...usageObservations([
        event({
          externalEventId: "evt-commit",
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Available,
            scheme: "claude-message",
            sourceRecordIds: ["msg_commit"],
          },
        }),
      ]),
      ...usageObservations([
        event({
          externalEventId: "evt-both",
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Available,
            scheme: "claude-message",
            sourceRecordIds: ["msg_both"],
          },
        }),
      ]),
    ];
    const { operations } = recipientsAndOperations([
      implementation({
        requestKeys: ["claude-message:msg_both", "claude-message:msg_commit"],
      }),
      evidence({
        receiptId: "receipt-1",
        anchors: { requestKey: "claude-message:msg_both" },
      }),
    ]);

    const { proofs, unproven } = associateUsageWithReasons({
      units,
      segments: [],
      operations,
      workItemRecipients: new Map(),
    });

    expect(new Set(proofs.map((proof) => proof.recipientKey))).toEqual(
      new Set(["branch-1"])
    );
    expect(
      proofs.every((proof) =>
        proof.sourceKey.startsWith("claude-message:msg_commit")
      )
    ).toBe(true);
    expect(new Set(unproven.map((entry) => entry.reason))).toEqual(
      new Set([UnprovenUsageReason.MultiTargetRequest])
    );
  });

  it("proves a request joined to two branches for neither, and a request joined to one for its branch", () => {
    const units = [
      ...usageObservations([
        event({
          externalEventId: "evt-one",
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Available,
            scheme: "claude-message",
            sourceRecordIds: ["msg_one"],
          },
        }),
      ]),
      ...usageObservations([
        event({
          externalEventId: "evt-two",
          sourceIdentity: {
            availability: TokenSourceIdentityAvailability.Available,
            scheme: "claude-message",
            sourceRecordIds: ["msg_two"],
          },
        }),
      ]),
    ];
    const { operations } = recipientsAndOperations([
      evidence({
        targetArtifactId: "branch-1",
        relationshipKind: AttributionRelationshipKind.Implementation,
        invokedAt: null,
        anchors: {
          requestKeys: ["claude-message:msg_one", "claude-message:msg_two"],
        },
      }),
      evidence({
        targetArtifactId: "branch-2",
        relationshipKind: AttributionRelationshipKind.Implementation,
        invokedAt: null,
        anchors: { requestKeys: ["claude-message:msg_two"] },
      }),
    ]);

    const { proofs, unproven } = associateUsageWithReasons({
      units,
      segments: [],
      operations,
      workItemRecipients: new Map(),
    });

    const twoBranchUnits = units.filter((unit) =>
      unit.sourceKey.startsWith("claude-message:msg_two")
    );
    expect(twoBranchUnits.length).toBeGreaterThan(0);
    expect(
      proofs.filter((proof) =>
        proof.sourceKey.startsWith("claude-message:msg_two")
      )
    ).toEqual([]);
    expect(
      unproven.filter((entry) =>
        entry.sourceKey.startsWith("claude-message:msg_two")
      )
    ).toEqual(
      twoBranchUnits.map((unit) => ({
        sourceKey: unit.sourceKey,
        reason: UnprovenUsageReason.MultiTargetRequest,
      }))
    );
    expect(
      new Set(
        proofs
          .filter((proof) =>
            proof.sourceKey.startsWith("claude-message:msg_one")
          )
          .map((proof) => proof.recipientKey)
      )
    ).toEqual(new Set(["branch-1"]));
  });

  it("puts a receipted write whose request is unknown on the agent and phase fallback", () => {
    // A write nested in two concurrently open Codex exec calls names no
    // request, so its evidence row carries a receipt and no request key.
    const { operations } = recipientsAndOperations([
      evidence({ receiptId: "receipt-nested", anchors: {} }),
    ]);
    const units = usageObservations([event()]);

    const { proofs } = associateUsageWithReasons({
      units,
      segments: [
        {
          agentId: null,
          phase: ACTIVITY_PHASE.Plan,
          startMs: AT.getTime() - 1000,
          endMs: AT.getTime() + 1000,
          workItemRef: null,
        },
      ],
      operations,
      workItemRecipients: new Map(),
    });

    expect(operations.map((operation) => operation.requestKey)).toEqual([null]);
    expect(new Set(proofs.map((proof) => proof.method))).toEqual(
      new Set([UsageAssociationMethod.AgentPhaseRun])
    );
    expect(new Set(proofs.map((proof) => proof.recipientKey))).toEqual(
      new Set(["doc-1"])
    );
  });

  it("writes a claim's candidate requests to its anchors and reads them back for a receipted write (ISS-12552)", () => {
    const anchors = claimRequestAnchors({
      candidateRequestKeys: ["codex:resp_a", "codex:resp_b"],
    });
    const { operations } = recipientsAndOperations([
      evidence({ receiptId: "receipt-nested", anchors }),
      evidence({ targetArtifactId: "doc-2", anchors }),
    ]);

    expect(anchors).toEqual({
      candidateRequestKeys: ["codex:resp_a", "codex:resp_b"],
    });
    expect(claimRequestAnchors({ requestKey: "codex:resp_a" })).toEqual({
      requestKey: "codex:resp_a",
    });
    expect(operations).toEqual([
      expect.objectContaining({
        requestKey: null,
        candidateRequestKeys: ["codex:resp_a", "codex:resp_b"],
      }),
      expect.not.objectContaining({ candidateRequestKeys: expect.anything() }),
    ]);
  });
});
