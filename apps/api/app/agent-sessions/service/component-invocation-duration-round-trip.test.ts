import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import {
  mapInvocationCreate,
  toSyncItem,
} from "./component-invocation-wire-row";

describe("duration survives cloud persistence and hash reconstruction", () => {
  it.each([undefined, 0, 10_000, Number.MAX_SAFE_INTEGER])(
    "round-trips %s without altering wire presence",
    (durationMs) => {
      const item: AgentComponentInvocationSyncItem = {
        externalInvocationId: "call-a",
        sourceSessionId: "session-a",
        kind: AgentComponentInvocationKind.Tool,
        componentKey: "Read",
        relationship: AgentComponentInvocationRelationship.Direct,
        invokedAt: "2026-10-19T12:00:00.000Z",
        sequence: 0,
        anchor: { kind: AgentComponentInvocationAnchorKind.Session },
        status: AgentComponentInvocationAttributionStatus.Unresolved,
        evidenceClass: AgentComponentInvocationEvidenceClass.None,
        ...(durationMs === undefined ? {} : { durationMs }),
      };
      const created = mapInvocationCreate("generation-a", "part-a", item);
      expect(created.durationMs).toBe(
        durationMs === undefined ? null : BigInt(durationMs)
      );
      // The timed item has no money; all other create fields already match the
      // staged-row representation read by the real hash reconstruction mapper.
      const row = { ...created, id: "row-a", estimatedCost: null };
      expect(toSyncItem(row)).toStrictEqual(item);
    }
  );
});
