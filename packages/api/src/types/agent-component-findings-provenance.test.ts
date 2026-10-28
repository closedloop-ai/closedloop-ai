import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_FINDINGS_PROVENANCE_VALUES,
  AgentComponentFindingsProvenance,
  agentComponentFindingsProvenanceLabel,
  isAgentComponentFindingsIngestRoute,
  isAgentComponentFindingsProducerStated,
  isAgentComponentFindingsProvenance,
} from "./agent-component-findings-provenance.ts";

/**
 * Written out as literals ON PURPOSE. A member list read back through the const
 * it polices agrees with the const whatever the const says, so deleting a
 * member would leave such a test green. The duplication IS the test.
 */
const EXPECTED_PROVENANCE_VALUES = [
  "plugin-emitted",
  "transcript-recovered",
  "unresolved",
];

describe("AgentComponentFindingsProvenance", () => {
  it("carries exactly the three routes, pinned by literal and not by itself", () => {
    expect([...AGENT_COMPONENT_FINDINGS_PROVENANCE_VALUES].sort()).toEqual(
      [...EXPECTED_PROVENANCE_VALUES].sort()
    );
  });

  // A distinctness check alone is satisfied by any three distinct strings IN
  // ANY PAIRING, so swapping two labels would leave it green and render a
  // heuristic reconstruction as the trustworthy source — the precise inversion
  // this module exists to prevent. The words are therefore pinned to the
  // member, as literals.
  it("binds each route to its own words, not merely to a distinct string", () => {
    expect(
      agentComponentFindingsProvenanceLabel(
        AgentComponentFindingsProvenance.PluginEmitted
      )
    ).toBe("Plugin-emitted");
    expect(
      agentComponentFindingsProvenanceLabel(
        AgentComponentFindingsProvenance.TranscriptRecovered
      )
    ).toBe("Transcript-recovered");
    expect(
      agentComponentFindingsProvenanceLabel(
        AgentComponentFindingsProvenance.Unresolved
      )
    ).toBe("Source unknown");
  });

  it("labels the three routes distinguishably, so no two share a cell", () => {
    const labels = AGENT_COMPONENT_FINDINGS_PROVENANCE_VALUES.map((value) =>
      agentComponentFindingsProvenanceLabel(value)
    );
    for (const label of labels) {
      expect(label).not.toBe("");
    }
    expect(new Set(labels).size).toBe(
      AGENT_COMPONENT_FINDINGS_PROVENANCE_VALUES.length
    );
  });

  it("treats only the plugin envelope as the producer's own count", () => {
    expect(
      isAgentComponentFindingsProducerStated(
        AgentComponentFindingsProvenance.PluginEmitted
      )
    ).toBe(true);
    expect(
      isAgentComponentFindingsProducerStated(
        AgentComponentFindingsProvenance.TranscriptRecovered
      )
    ).toBe(false);
    // The value an unlabelled legacy row reads as. It must never present as
    // the trustworthy source.
    expect(
      isAgentComponentFindingsProducerStated(
        AgentComponentFindingsProvenance.Unresolved
      )
    ).toBe(false);
  });

  // The two guards accept different sets ON PURPOSE, so a test that only
  // checked one of them on a given value would not see them diverge. Each
  // member is asserted against BOTH here: an ingest may declare a real route,
  // and may not declare the value the read coalesces an unreadable label to.
  it("lets an ingest declare a real route but not the read-side fallback", () => {
    expect(
      isAgentComponentFindingsIngestRoute(
        AgentComponentFindingsProvenance.PluginEmitted
      )
    ).toBe(true);
    expect(
      isAgentComponentFindingsIngestRoute(
        AgentComponentFindingsProvenance.TranscriptRecovered
      )
    ).toBe(true);
    expect(
      isAgentComponentFindingsIngestRoute(
        AgentComponentFindingsProvenance.Unresolved
      )
    ).toBe(false);
    // ...while the READ boundary's guard still recognizes all three, which is
    // what keeps a stored `unresolved` row readable rather than discarded.
    expect(
      isAgentComponentFindingsProvenance(
        AgentComponentFindingsProvenance.Unresolved
      )
    ).toBe(true);
  });

  it("refuses a value it has no description for", () => {
    const notProvenances = [
      "",
      "measured",
      "estimated",
      "plugin",
      "PLUGIN-EMITTED",
      "toString",
      undefined,
      null,
      0,
    ];
    for (const value of notProvenances) {
      expect(isAgentComponentFindingsProvenance(value)).toBe(false);
    }
    for (const value of EXPECTED_PROVENANCE_VALUES) {
      expect(isAgentComponentFindingsProvenance(value)).toBe(true);
    }
    for (const value of notProvenances) {
      expect(isAgentComponentFindingsIngestRoute(value)).toBe(false);
    }
  });
});
