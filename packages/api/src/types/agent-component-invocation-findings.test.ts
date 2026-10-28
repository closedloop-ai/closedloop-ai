import { describe, expect, it } from "vitest";
import { AgentComponentFindingsFunnelState } from "./agent-component-findings-funnel.ts";
import { AgentComponentFindingsProvenance } from "./agent-component-findings-provenance.ts";
import {
  AGENT_COMPONENT_INVOCATION_FINDINGS_READ_KEYS,
  type AgentComponentInvocationFindingsReadFields,
  agentComponentInvocationFindingsFields,
  agentComponentInvocationFindingsInvalidationRate,
  readAgentComponentInvocationFindings,
} from "./agent-component-invocation-findings.ts";

describe("agentComponentInvocationFindingsFields", () => {
  it("publishes a measured funnel with both counts", () => {
    expect(
      agentComponentInvocationFindingsFields({
        funnel: { findingsEmitted: 6, findingsInvalidated: 2 },
      })
      // Literal, not the constant: a renamed wire value must redden here.
    ).toEqual({
      findingsState: "measured",
      findingsEmitted: 6,
      findingsInvalidated: 2,
    });
  });

  it("distinguishes measured-zero from not-measured and not-applicable", () => {
    const measuredZero = agentComponentInvocationFindingsFields({
      funnel: { findingsEmitted: 0, findingsInvalidated: 0 },
    });
    const notMeasured = agentComponentInvocationFindingsFields({});
    const notApplicable = agentComponentInvocationFindingsFields({
      kindDeclaresNoFindingsOutput: true,
    });

    expect(measuredZero).toEqual({
      findingsState: "measured",
      findingsEmitted: 0,
      findingsInvalidated: 0,
    });
    expect(notMeasured).toEqual({});
    expect(notApplicable).toEqual({ findingsState: "not_applicable" });

    // The three are pairwise different ON THE WIRE, which is the contract a
    // consumer depends on — not merely different in this process.
    const wire = [measuredZero, notMeasured, notApplicable].map((fields) =>
      JSON.stringify(fields)
    );
    expect(new Set(wire).size).toBe(3);
  });

  it("omits the state rather than serializing an unknown value", () => {
    expect(
      Object.hasOwn(agentComponentInvocationFindingsFields({}), "findingsState")
    ).toBe(false);
    expect(JSON.stringify(agentComponentInvocationFindingsFields({}))).toBe(
      "{}"
    );
  });

  it("keeps a real measurement when the kind declares no findings output", () => {
    expect(
      agentComponentInvocationFindingsFields({
        funnel: { findingsEmitted: 3, findingsInvalidated: 1 },
        kindDeclaresNoFindingsOutput: true,
      }).findingsState
    ).toBe("measured");
  });

  it("reads an inadmissible stored pair as not measured", () => {
    for (const funnel of [
      { findingsEmitted: 1, findingsInvalidated: 2 },
      { findingsEmitted: -1, findingsInvalidated: 0 },
      { findingsEmitted: 1.5, findingsInvalidated: 0 },
      { findingsEmitted: Number.POSITIVE_INFINITY, findingsInvalidated: 0 },
    ]) {
      expect(agentComponentInvocationFindingsFields({ funnel })).toEqual({});
    }
  });

  it("adds exactly the declared keys and no cost-per-finding value", () => {
    const fields = agentComponentInvocationFindingsFields({
      funnel: { findingsEmitted: 6, findingsInvalidated: 2 },
    });
    expect(Object.keys(fields).sort()).toEqual(
      ["findingsEmitted", "findingsInvalidated", "findingsState"].sort()
    );
    // ISS-11325 added `findingsDisposition` to the projection's key set. It is
    // absent from the FIELDS above because this source declares no disposition,
    // which is the point: the key is emitted only when something recorded one.
    expect([...AGENT_COMPONENT_INVOCATION_FINDINGS_READ_KEYS].sort()).toEqual(
      [
        "findingsDisposition",
        "findingsEmitted",
        "findingsInvalidated",
        "findingsState",
      ].sort()
    );
  });

  it("publishes a recorded disposition beside the counts and on a withheld row, and refuses one the counts refute", () => {
    // Measured, with the statement that the counts are this run's own.
    expect(
      agentComponentInvocationFindingsFields({
        funnel: { findingsEmitted: 6, findingsInvalidated: 2 },
        disposition: "carried-forward",
      }).findingsDisposition
    ).toBe("carried-forward");

    // THE ROW THE COLUMN EXISTS FOR: no counts, and a reason for that.
    const withheld = agentComponentInvocationFindingsFields({
      funnel: null,
      disposition: "withheld-byte-gated",
    });
    expect(withheld.findingsDisposition).toBe("withheld-byte-gated");
    expect(Object.hasOwn(withheld, "findingsEmitted")).toBe(false);
    expect(Object.hasOwn(withheld, "findingsState")).toBe(false);

    // A withheld label beside real counts is refused rather than published: the
    // counts are evidence and the label is a claim they refute. Omission reads
    // `unrecorded`, which is a different fact from either.
    expect(
      Object.hasOwn(
        agentComponentInvocationFindingsFields({
          funnel: { findingsEmitted: 6, findingsInvalidated: 2 },
          disposition: "withheld-byte-gated",
        }),
        "findingsDisposition"
      )
    ).toBe(false);

    // And so is `unrecorded` itself, plus a member this build cannot place.
    for (const cell of ["unrecorded", "withheld-from-a-newer-build", null]) {
      expect(
        Object.hasOwn(
          agentComponentInvocationFindingsFields({
            funnel: null,
            disposition: cell,
          }),
          "findingsDisposition"
        )
      ).toBe(false);
    }
  });
});

describe("readAgentComponentInvocationFindings", () => {
  it("derives findingsConfirmed and never carries it on the wire", () => {
    const fields = agentComponentInvocationFindingsFields({
      funnel: { findingsEmitted: 6, findingsInvalidated: 2 },
    });
    expect(Object.hasOwn(fields, "findingsConfirmed")).toBe(false);

    const reading = readAgentComponentInvocationFindings(fields);
    expect(reading).toEqual({
      state: "measured",
      findingsEmitted: 6,
      findingsInvalidated: 2,
      findingsConfirmed: 4,
      // ISS-10739: every Measured reading carries how the count was obtained.
      // The wire row has no label, which reads `Unresolved` — a distinct fact
      // from either real source, not a default onto the stronger one.
      findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
    });
  });

  it("derives confirmed from the operands on every admissible pair", () => {
    for (let emitted = 0; emitted <= 12; emitted += 1) {
      for (let invalidated = 0; invalidated <= emitted; invalidated += 1) {
        const reading = readAgentComponentInvocationFindings(
          agentComponentInvocationFindingsFields({
            funnel: {
              findingsEmitted: emitted,
              findingsInvalidated: invalidated,
            },
          })
        );
        if (reading.state !== AgentComponentFindingsFunnelState.Measured) {
          throw new Error("expected a measured reading");
        }
        expect(reading.findingsConfirmed).toBe(emitted - invalidated);
      }
    }
  });

  it("folds each wire shape back to its own state", () => {
    expect(readAgentComponentInvocationFindings({}).state).toBe("unknown");
    expect(
      readAgentComponentInvocationFindings({ findingsState: "not_applicable" })
        .state
    ).toBe("not_applicable");
    expect(
      readAgentComponentInvocationFindings({
        findingsState: "measured",
        findingsEmitted: 0,
        findingsInvalidated: 0,
      })
    ).toEqual({
      state: "measured",
      findingsEmitted: 0,
      findingsInvalidated: 0,
      findingsConfirmed: 0,
      findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
    });
  });

  it("reads a measured claim with no usable counts as unknown, not zero", () => {
    expect(
      readAgentComponentInvocationFindings({ findingsState: "measured" }).state
    ).toBe("unknown");
    expect(
      readAgentComponentInvocationFindings({
        findingsState: "measured",
        findingsEmitted: 1,
      }).state
    ).toBe("unknown");
  });

  it("keeps a skewed peer's real counts over its contradictory declaration", () => {
    // The producer here never emits this pair together; a version-skewed one
    // can, and dropping the counts would remove a reporting invocation from
    // both the numerator and the population of every rate built on this fold.
    expect(
      readAgentComponentInvocationFindings({
        findingsState: AgentComponentFindingsFunnelState.NotApplicable,
        findingsEmitted: 4,
        findingsInvalidated: 1,
      })
    ).toEqual({
      state: AgentComponentFindingsFunnelState.Measured,
      findingsEmitted: 4,
      findingsInvalidated: 1,
      findingsConfirmed: 3,
      // ISS-10739 made the label mandatory on every Measured reading. The wire
      // row carries no label, so a skewed peer's counts are kept AND honestly
      // labelled `Unresolved` — never promoted to a route nobody recorded.
      findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
    });
    // An INADMISSIBLE pair is not a measurement, so the declaration stands.
    expect(
      readAgentComponentInvocationFindings({
        findingsState: AgentComponentFindingsFunnelState.NotApplicable,
        findingsEmitted: 1,
        findingsInvalidated: 4,
      }).state
    ).toBe(AgentComponentFindingsFunnelState.NotApplicable);
  });

  it("degrades a state an older peer never sent, and one a newer peer invents", () => {
    const skewed = { findingsState: "partially_measured" } as unknown;
    expect(
      readAgentComponentInvocationFindings(
        skewed as AgentComponentInvocationFindingsReadFields
      ).state
    ).toBe("unknown");
  });
});

describe("agentComponentInvocationFindingsInvalidationRate", () => {
  it("carries the reporting population, at the INVOCATION grain, beside the rate", () => {
    const rate = agentComponentInvocationFindingsInvalidationRate([
      agentComponentInvocationFindingsFields({
        funnel: { findingsEmitted: 6, findingsInvalidated: 2 },
      }),
      agentComponentInvocationFindingsFields({
        funnel: { findingsEmitted: 2, findingsInvalidated: 1 },
      }),
      agentComponentInvocationFindingsFields({}),
      agentComponentInvocationFindingsFields({
        kindDeclaresNoFindingsOutput: true,
      }),
    ]);
    if (!rate.known) {
      throw new Error("expected a known rate");
    }
    expect(rate.rate).toBeCloseTo(3 / 8);
    expect(rate.reportingInvocations).toBe(2);
    expect(rate.populationInvocations).toBe(4);
  });

  it("cannot publish a rate without its population", () => {
    const rates = [
      agentComponentInvocationFindingsInvalidationRate([]),
      agentComponentInvocationFindingsInvalidationRate([
        agentComponentInvocationFindingsFields({}),
      ]),
      agentComponentInvocationFindingsInvalidationRate([
        agentComponentInvocationFindingsFields({
          funnel: { findingsEmitted: 4, findingsInvalidated: 1 },
        }),
      ]),
    ];
    for (const rate of rates) {
      expect(Object.hasOwn(rate, "reportingInvocations")).toBe(true);
      expect(Object.hasOwn(rate, "populationInvocations")).toBe(true);
    }
  });

  it("does not report a rate when nothing reported", () => {
    const rate = agentComponentInvocationFindingsInvalidationRate([
      agentComponentInvocationFindingsFields({}),
      agentComponentInvocationFindingsFields({
        kindDeclaresNoFindingsOutput: true,
      }),
    ]);
    expect(rate.known).toBe(false);
    expect(rate.reportingInvocations).toBe(0);
    expect(rate.populationInvocations).toBe(2);
  });
});
