import { ACTIVITY_PHASE } from "@repo/api/src/types/activity-phase";
import {
  UsageAssociationMethod,
  UsageTokenCategory,
} from "@repo/api/src/types/attribution-evidence";
import { describe, expect, it } from "vitest";
import {
  type AssociateUsageInput,
  type AssociationSegment,
  associateUsage,
  associateUsageWithReasons,
  type QualifyingOperation,
  requestRecipient,
  UnprovenUsageReason,
  type UsageObservation,
  UsageOperationClass,
} from "./associate-usage";

const PRD = "artifact:prd";
const PLAN_DOC = "artifact:plan";
const BRANCH = "artifact:branch";
const REVIEWER = "agent-reviewer";
const WRITER = "agent-writer";

function segment(
  phase: string,
  startMs: number,
  endMs: number,
  extra: Partial<AssociationSegment> = {}
): AssociationSegment {
  return { agentId: null, phase, startMs, endMs, workItemRef: null, ...extra };
}

function usage(
  sourceKey: string,
  atMs: number,
  agentId: string | null = null,
  requestKeys: readonly string[] = []
): UsageObservation {
  return {
    sourceKey,
    agentId,
    priceKey: "claude-opus-4",
    category: UsageTokenCategory.Output,
    tokens: 100,
    atMs,
    requestKeys,
  };
}

function operation(
  recipientKey: string,
  operationClass: UsageOperationClass,
  atMs: number,
  agentId: string | null = null,
  requestKey: string | null = null
): QualifyingOperation {
  return { recipientKey, operationClass, agentId, atMs, requestKey };
}

function associate(input: Partial<AssociateUsageInput>) {
  return associateUsage({
    units: [],
    segments: [],
    operations: [],
    workItemRecipients: new Map(),
    ...input,
  }).map(({ sourceKey, recipientKey, method }) => [
    sourceKey,
    recipientKey,
    method,
  ]);
}

describe("associateUsage (AC-015)", () => {
  it("follows interleaved plan and implement phases to the artifact each one wrote", () => {
    expect(
      associate({
        segments: [
          segment(ACTIVITY_PHASE.Plan, 0, 100),
          segment(ACTIVITY_PHASE.Implement, 100, 200),
          segment(ACTIVITY_PHASE.Plan, 200, 300),
        ],
        operations: [
          operation(PRD, UsageOperationClass.Plan, 90),
          operation(BRANCH, UsageOperationClass.Implementation, 150),
          operation(PLAN_DOC, UsageOperationClass.Plan, 250),
        ],
        units: [usage("u1", 10), usage("u2", 120), usage("u3", 210)],
      })
    ).toEqual([
      ["u1", PRD, UsageAssociationMethod.AgentPhaseRun],
      ["u2", BRANCH, UsageAssociationMethod.AgentPhaseRun],
      ["u3", PLAN_DOC, UsageAssociationMethod.AgentPhaseRun],
    ]);
  });

  it("keeps concurrent subagents' usage with the artifact each one wrote", () => {
    expect(
      associate({
        segments: [
          segment(ACTIVITY_PHASE.Plan, 0, 100, { agentId: WRITER }),
          segment(ACTIVITY_PHASE.Review, 0, 100, { agentId: REVIEWER }),
          segment(ACTIVITY_PHASE.Plan, 0, 100),
        ],
        operations: [
          operation(PRD, UsageOperationClass.Plan, 50, WRITER),
          operation(PLAN_DOC, UsageOperationClass.Comment, 60, REVIEWER),
        ],
        units: [
          usage("writer", 40, WRITER),
          usage("reviewer", 40, REVIEWER),
          usage("parent", 40),
        ],
      })
    ).toEqual([
      ["writer", PRD, UsageAssociationMethod.AgentPhaseRun],
      ["reviewer", PLAN_DOC, UsageAssociationMethod.AgentPhaseRun],
    ]);
  });

  it("never proves usage from a phase name alone", () => {
    expect(
      associate({
        segments: [segment(ACTIVITY_PHASE.Plan, 0, 100)],
        units: [usage("u1", 10)],
      })
    ).toEqual([]);
  });

  it("never proves usage from an operation's timestamp alone", () => {
    expect(
      associate({
        segments: [
          segment(ACTIVITY_PHASE.Explore, 0, 100),
          segment(ACTIVITY_PHASE.Implement, 100, 200),
        ],
        operations: [
          operation(PRD, UsageOperationClass.Plan, 50),
          operation(PRD, UsageOperationClass.Plan, 150),
        ],
        units: [usage("explore", 50), usage("implement", 150)],
      })
    ).toEqual([]);
  });

  it("does not prove one agent's usage by another agent's operation", () => {
    expect(
      associate({
        segments: [segment(ACTIVITY_PHASE.Plan, 0, 100)],
        operations: [operation(PRD, UsageOperationClass.Plan, 50, WRITER)],
        units: [usage("parent", 40)],
      })
    ).toEqual([]);
  });

  it("ends a run at a phase of another class, so a later run needs its own operation", () => {
    expect(
      associate({
        segments: [
          segment(ACTIVITY_PHASE.Plan, 0, 100),
          segment(ACTIVITY_PHASE.Idle, 100, 200),
          segment(ACTIVITY_PHASE.Plan, 200, 300),
        ],
        operations: [operation(PRD, UsageOperationClass.Plan, 50)],
        units: [usage("first", 10), usage("second", 250)],
      })
    ).toEqual([["first", PRD, UsageAssociationMethod.AgentPhaseRun]]);
  });

  it("uses the segment's work item ref when the run wrote more than one artifact", () => {
    expect(
      associate({
        segments: [
          segment(ACTIVITY_PHASE.Plan, 0, 100, { workItemRef: "PRD-1" }),
          segment(ACTIVITY_PHASE.Plan, 100, 200),
        ],
        operations: [
          operation(PRD, UsageOperationClass.Plan, 50),
          operation(PLAN_DOC, UsageOperationClass.Plan, 150),
        ],
        units: [usage("referenced", 10), usage("unreferenced", 150)],
        workItemRecipients: new Map([["PRD-1", PRD]]),
      })
    ).toEqual([["referenced", PRD, UsageAssociationMethod.WorkItemRef]]);
  });

  it("ignores a work item ref the agent never operated on", () => {
    expect(
      associate({
        segments: [
          segment(ACTIVITY_PHASE.Plan, 0, 100, { workItemRef: "PRD-1" }),
        ],
        units: [usage("u1", 10)],
        workItemRecipients: new Map([["PRD-1", PRD]]),
      })
    ).toEqual([]);
  });

  it("proves nothing when the run and the work item ref name different artifacts", () => {
    expect(
      associate({
        segments: [
          segment(ACTIVITY_PHASE.Plan, 0, 100, { workItemRef: "PRD-1" }),
          segment(ACTIVITY_PHASE.Idle, 100, 200),
          segment(ACTIVITY_PHASE.Plan, 200, 300),
        ],
        operations: [
          operation(PLAN_DOC, UsageOperationClass.Plan, 50),
          operation(PRD, UsageOperationClass.Plan, 250),
        ],
        units: [usage("u1", 10)],
        workItemRecipients: new Map([["PRD-1", PRD]]),
      })
    ).toEqual([]);
  });

  it("proves usage for a timeless operation only through a work item ref", () => {
    expect(
      associate({
        segments: [
          segment(ACTIVITY_PHASE.Implement, 0, 100, { workItemRef: "feat/x" }),
          segment(ACTIVITY_PHASE.Idle, 100, 200),
          segment(ACTIVITY_PHASE.Implement, 200, 300),
        ],
        operations: [
          {
            ...operation(BRANCH, UsageOperationClass.Implementation, 0),
            atMs: null,
          },
        ],
        units: [usage("referenced", 10), usage("unreferenced", 250)],
        workItemRecipients: new Map([["feat/x", BRANCH]]),
      })
    ).toEqual([["referenced", BRANCH, UsageAssociationMethod.WorkItemRef]]);
  });

  it("proves each unit at most once", () => {
    const proofs = associate({
      segments: [
        segment(ACTIVITY_PHASE.Implement, 0, 100),
        segment(ACTIVITY_PHASE.Validate, 100, 200),
        segment(ACTIVITY_PHASE.Implement, 0, 200, { agentId: WRITER }),
      ],
      operations: [
        operation(BRANCH, UsageOperationClass.Implementation, 50),
        operation(BRANCH, UsageOperationClass.Implementation, 50, WRITER),
      ],
      units: [usage("a", 50), usage("b", 150), usage("c", 150, WRITER)],
    });

    expect(proofs.map(([sourceKey]) => sourceKey)).toEqual(["a", "b", "c"]);
  });
});

describe("associateUsage, request-to-receipt join", () => {
  const PLAN = UsageOperationClass.Plan;

  it("proves a request's usage for the artifact its receipted write names, whatever the phase", () => {
    expect(
      associate({
        units: [
          usage("req-1#output", 10, null, ["claude:line-a", "claude:line-b"]),
          usage("req-2#output", 20, null, ["claude:line-c"]),
        ],
        segments: [segment(ACTIVITY_PHASE.Explore, 0, 100)],
        operations: [operation("doc-1", PLAN, 12, null, "claude:line-b")],
      })
    ).toEqual([
      ["req-1#output", "doc-1", UsageAssociationMethod.RequestReceipt],
    ]);
  });

  it("proves no artifact for a request whose receipted writes name two, even with a work item ref", () => {
    const input = {
      units: [usage("req-1#output", 10, null, ["claude:line-a"])],
      segments: [
        segment(ACTIVITY_PHASE.Plan, 0, 100, { workItemRef: "ISS-1" }),
      ],
      operations: [
        operation("issue-1", PLAN, 12, null, "claude:line-a"),
        operation("plan-2", PLAN, 13, null, "claude:line-a"),
      ],
      workItemRecipients: new Map([["ISS-1", "issue-1"]]),
    };

    expect(associate(input)).toEqual([]);
    expect(
      associateUsageWithReasons({ ...input }).unproven.map(
        (entry) => entry.reason
      )
    ).toEqual([UnprovenUsageReason.MultiTargetRequest]);
  });

  it("never lets a receipted write prove other requests through its phase run", () => {
    expect(
      associate({
        units: [
          usage("req-1#output", 10, null, ["claude:line-a"]),
          usage("req-2#output", 20, null, ["claude:line-c"]),
        ],
        segments: [segment(ACTIVITY_PHASE.Plan, 0, 100)],
        operations: [operation("doc-1", PLAN, 12, null, "claude:line-a")],
      })
    ).toEqual([
      ["req-1#output", "doc-1", UsageAssociationMethod.RequestReceipt],
    ]);
  });

  it("keeps the agent and phase fallback for a write with no request join", () => {
    expect(
      associate({
        units: [usage("req-2#output", 20, null, ["claude:line-c"])],
        segments: [segment(ACTIVITY_PHASE.Plan, 0, 100)],
        operations: [operation("doc-1", PLAN, 12)],
      })
    ).toEqual([
      ["req-2#output", "doc-1", UsageAssociationMethod.AgentPhaseRun],
    ]);
  });

  it("names the requestRecipient ruling in one place", () => {
    expect(requestRecipient(new Set(["doc-1"]))).toBe("doc-1");
    expect(requestRecipient(new Set(["doc-1", "doc-2"]))).toBeUndefined();
  });

  it("proves only a nested write's candidate requests, and leaves a no-write closing request in the run unresolved", () => {
    const { proofs, unproven } = associateUsageWithReasons({
      units: [
        usage("exec-a#output", 10, null, ["codex:resp_a"]),
        usage("exec-b#output", 20, null, ["codex:resp_b"]),
        usage("closing#output", 30, null, ["codex:resp_c"]),
      ],
      segments: [segment(ACTIVITY_PHASE.Plan, 0, 100)],
      operations: [
        {
          ...operation(PRD, UsageOperationClass.Plan, 15),
          candidateRequestKeys: ["codex:resp_a", "codex:resp_b"],
        },
      ],
      workItemRecipients: new Map(),
    });

    expect(
      proofs.map(({ sourceKey, recipientKey, method }) => [
        sourceKey,
        recipientKey,
        method,
      ])
    ).toEqual([
      ["exec-a#output", PRD, UsageAssociationMethod.RequestReceipt],
      ["exec-b#output", PRD, UsageAssociationMethod.RequestReceipt],
    ]);
    expect(unproven).toEqual([
      {
        sourceKey: "closing#output",
        reason: UnprovenUsageReason.NoQualifyingEvidence,
      },
    ]);
  });

  it("keeps the whole-run fallback for an older Desktop's write, which names no request and no candidates", () => {
    expect(
      associate({
        units: [usage("u1#output", 10), usage("u2#output", 30)],
        segments: [segment(ACTIVITY_PHASE.Plan, 0, 100)],
        operations: [operation(PRD, UsageOperationClass.Plan, 15)],
      })
    ).toEqual([
      ["u1#output", PRD, UsageAssociationMethod.AgentPhaseRun],
      ["u2#output", PRD, UsageAssociationMethod.AgentPhaseRun],
    ]);
  });
});
