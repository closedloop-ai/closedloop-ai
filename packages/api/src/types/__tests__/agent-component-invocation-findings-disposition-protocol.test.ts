/**
 * ISS-11325: the sync protocol version a part carrying `findingsDisposition`
 * must declare, and the SELECTOR that derives it.
 *
 * The sibling of `agent-component-invocation-otel-evidence-protocol.test.ts`,
 * written because the first cut of this lane updated the three supported-list
 * pins and left the selector arm itself unobserved (review-soul, class B): the
 * pins assert the contents of
 * `AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS`, which deleting
 * the arm does not touch, and the schema refinement compares
 * `declared < required`, so an OVER-declared version validates too. The cost of
 * that regression is the one the constant's docblock spells out: a part carrying
 * the field would declare v7, an API that predates the field rejects the
 * unrecognized key at `.strict()`, and the client maps that 400 to the PERMANENT
 * `validation_failed` that dead-letters the whole generation.
 *
 * The literals are here deliberately. A test that read the version back through
 * the constant would agree with the constant whatever it said, and the number is
 * the whole contract with the other lanes.
 */
import { describe, expect, it, test } from "vitest";
import { AgentComponentFindingsDisposition } from "../agent-component-findings-disposition.ts";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_DISPOSITION_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  agentComponentInvocationSyncProtocolVersionForItems,
  isSupportedAgentComponentInvocationSyncProtocolVersion,
} from "../agent-component-invocation.ts";
import { agentComponentInvocationSyncItemSchema } from "../agent-component-invocation-schema.ts";

function baseItem(): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: "invocation-1",
    sourceSessionId: "session-1",
    kind: AgentComponentInvocationKind.Subagent,
    componentKey: "code-review:code-review-worker",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: "2026-09-27T16:00:00.000Z",
    sequence: 0,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}

describe("ISS-11325 findings-disposition protocol version", () => {
  it("is version eight, because seven is spent, and this build accepts it", () => {
    expect(
      AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_DISPOSITION_PROTOCOL_VERSION
    ).toBe(8);
    expect(isSupportedAgentComponentInvocationSyncProtocolVersion(8)).toBe(
      true
    );
  });

  it("lifts a part carrying the disposition to v8, and outranks the v7 arm", () => {
    // THE ARM ITSELF. Deleting it in `agentComponentInvocationSyncProtocolVersionForItems`
    // reddens exactly here and nowhere else in the suite.
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        {
          ...baseItem(),
          findingsDisposition:
            AgentComponentFindingsDisposition.WithheldByteGated,
        },
      ])
    ).toBe(8);

    // PRECEDENCE, which the arm's POSITION is the whole of: a part must declare
    // the HIGHEST version any of its fields introduced, so an item carrying the
    // disposition AND ISS-10720's v7 attribution source still reaches 8. Moving
    // the arm below the OTel one makes this 7 while the case above stays green.
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        {
          ...baseItem(),
          attributionSource:
            AgentComponentInvocationAttributionSource.HarnessOtel,
          findingsDisposition: AgentComponentFindingsDisposition.CarriedForward,
          findingsEmitted: 3,
          findingsInvalidated: 1,
        },
      ])
    ).toBe(8);
  });

  it("does not lift a part that carries no disposition", () => {
    // THE UNAFFECTED CASE. An arm that fired unconditionally would push every
    // part to v8 and make every older API answer `protocol_unsupported` for a
    // producer doing nothing new, so the negative is load-bearing.
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([baseItem()])
    ).toBe(1);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { ...baseItem(), findingsEmitted: 3, findingsInvalidated: 1 },
      ])
    ).toBe(5);
  });
});

describe("ISS-11325 boundary: a disposition its own funnel contradicts", () => {
  test("a withheld member beside real counts is rejected, not silently dropped", () => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...baseItem(),
      findingsEmitted: 3,
      findingsInvalidated: 1,
      findingsDisposition: AgentComponentFindingsDisposition.WithheldByteGated,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      "findings_disposition_contradicts_funnel"
    );
  });

  test("a measured member with no counts is rejected", () => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...baseItem(),
      findingsDisposition: AgentComponentFindingsDisposition.MeasuredThisRun,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      "findings_disposition_contradicts_funnel"
    );
  });
});
