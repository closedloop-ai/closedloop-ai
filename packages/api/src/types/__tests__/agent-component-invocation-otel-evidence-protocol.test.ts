/**
 * ISS-10720 — the wire half of the OTel-sourced attribution.
 *
 * `evidenceClass` is a `z.enum` derived from the const object and
 * `attributionSource` is a key an older `.strict()` item schema has never seen,
 * so an API that predates either accepts a v3 declaration and then rejects the
 * item — a 400 the client maps to `validation_failed`, which is permanent and
 * drops the whole generation. The version gate is what turns that into the
 * retryable `protocol_unsupported` instead, so these cases pin the gate rather
 * than the enum.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationEvidenceClass,
  agentComponentInvocationSyncProtocolVersionForItems,
  isSupportedAgentComponentInvocationSyncProtocolVersion,
} from "../agent-component-invocation.ts";

describe("ISS-10720 OTel attribution protocol version", () => {
  it("is version seven, because v4, v5 and v6 are spent", () => {
    // The three sibling lanes this file was written against have all merged:
    // ISS-10718 took v4 (`succeeded`), ISS-10725/10726 took v5 (the findings
    // funnel) and ISS-10730 took v6 (per-agent lines). This lane takes the next
    // free number at merge time, which is the rule each of those three states.
    // The literal is here deliberately — a test that read the constant back
    // would agree with the constant whatever it said, and the number is the
    // whole contract with the other lanes.
    expect(AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION).toBe(
      7
    );
    expect(isSupportedAgentComponentInvocationSyncProtocolVersion(7)).toBe(
      true
    );
  });

  it("lists exactly [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] after the merge, as LITERALS", () => {
    // NON-CIRCULAR ON PURPOSE. Every other assertion in this file's neighbours
    // reaches the version through the constant, so a lane that moved its own
    // constant kept a fully green suite — which is how two open PRs both
    // claimed v4 unnoticed. These literals are the trip-wire that makes a
    // version move visible.
    expect([
      ...AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
      // ISS-11325 added v8 for the findings disposition, ABOVE this lane's v7.
      // EXTENDED, never replaced — the same merge rule this file's neighbour
      // states: dropping a version a peer already ships dead-letters it forever.
    ]).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("keeps the supported list ascending and duplicate-free", () => {
    // THE MERGE GUARD, and the reason the literal pin above WENT red when the
    // sibling PRs landed. v4, v5 and v6 reached `main` while this branch sat;
    // the resolver UNIONED the lanes' entries rather than keeping one side, and
    // the pin above was updated to the result and this lane renumbered ABOVE
    // it — never "fixed" by editing the pin to whatever the merge happened to
    // produce. A numeric gap here means a merge was resolved wrong.
    const versions = [
      ...AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
    ];
    expect(versions).toContain(
      AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION
    );
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("requires the OTel version for an item carrying the OTel evidence class", () => {
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        {
          evidenceClass: AgentComponentInvocationEvidenceClass.OtelCounter,
        },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION);
  });

  it("requires the OTel version for an item carrying the attribution source", () => {
    // The two axes move independently — a row can keep its transcript-derived
    // definition evidence AND record that the harness attributed it — so the
    // gate must fire on the field, not only on the evidence class.
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        {
          evidenceClass:
            AgentComponentInvocationEvidenceClass.CollectorSnapshot,
          attributionSource:
            AgentComponentInvocationAttributionSource.HarnessOtel,
        },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION);
  });

  it("leaves a part of transcript-evidenced items on the version it already declared", () => {
    // The counterpart to the two cases above: the gate must be the new fields,
    // not "this build emits v6 now" — a build that bumped every part would make
    // every telemetry-free part unreadable to a deployed API for no reason.
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        {
          evidenceClass:
            AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
        },
      ])
    ).toBe(1);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        {
          evidenceClass:
            AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
          usageMeasurement: "measured",
        },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION);
  });
});
