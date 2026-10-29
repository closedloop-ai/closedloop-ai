import { describe, expect, it } from "vitest";
import { AgentComponentFindingsDisposition } from "./agent-component-findings-disposition.ts";
import {
  AGENT_COMPONENT_FINDINGS_FUNNEL_INGEST_KEYS,
  AgentComponentFindingsCellsReading,
  AgentComponentFindingsFunnelState,
  type AgentComponentFindingsInvalidationRate,
  agentComponentFindingsInvalidationRate,
  isAgentComponentFindingsFunnel,
  readAgentComponentFindingsFunnel,
  readStoredAgentComponentFindingsCells,
  storedAgentComponentFindingsFunnel,
  storedAgentComponentFindingsWireProjection,
} from "./agent-component-findings-funnel.ts";
import { AgentComponentFindingsProvenance } from "./agent-component-findings-provenance.ts";

/** Literal, never read back through the const it polices. */
const EXPECTED_INGEST_KEYS = [
  "findingsEmitted",
  "findingsInvalidated",
  "findingsProvenance",
];

/** A fresh empty breakdown, spelled out so the expectations stay readable. */
function emptyTally() {
  return {
    reportingComponents: 0,
    findingsEmitted: 0,
    findingsInvalidated: 0,
    representable: true,
  };
}

describe("readAgentComponentFindingsFunnel", () => {
  it("separates an absent funnel from a measured zero", () => {
    expect(readAgentComponentFindingsFunnel(undefined)).toEqual({
      state: AgentComponentFindingsFunnelState.Unknown,
    });
    expect(
      readAgentComponentFindingsFunnel({
        findingsEmitted: 0,
        findingsInvalidated: 0,
        findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
      })
    ).toEqual({
      state: AgentComponentFindingsFunnelState.Measured,
      findingsEmitted: 0,
      findingsInvalidated: 0,
      findingsConfirmed: 0,
      findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
    });
  });

  it("derives confirmed rather than reading a stored third number", () => {
    expect(
      readAgentComponentFindingsFunnel({
        findingsEmitted: 10,
        findingsInvalidated: 3,
        findingsProvenance:
          AgentComponentFindingsProvenance.TranscriptRecovered,
      })
    ).toMatchObject({ findingsConfirmed: 7 });
  });

  it("reads an impossible stored pair as unknown, never as a number", () => {
    const impossible = [
      { findingsEmitted: 1.5, findingsInvalidated: 0 },
      { findingsEmitted: Number.POSITIVE_INFINITY, findingsInvalidated: 0 },
      { findingsEmitted: Number.NaN, findingsInvalidated: 0 },
      { findingsEmitted: -1, findingsInvalidated: 0 },
      { findingsEmitted: Number.MAX_SAFE_INTEGER + 2, findingsInvalidated: 0 },
      { findingsEmitted: 2, findingsInvalidated: 3 },
    ];
    for (const funnel of impossible) {
      expect(
        readAgentComponentFindingsFunnel({
          ...funnel,
          findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
        })
      ).toEqual({
        state: AgentComponentFindingsFunnelState.Unknown,
      });
    }
  });

  // ISS-10739 AC: legacy rows with counts and no label read as unknown-source,
  // distinguishable from both real sources.
  it("reads a legacy row's counts, labelling them unresolved and not plugin-emitted", () => {
    const legacy = readAgentComponentFindingsFunnel({
      findingsEmitted: 9,
      findingsInvalidated: 4,
    });

    expect(legacy).toEqual({
      state: AgentComponentFindingsFunnelState.Measured,
      findingsEmitted: 9,
      findingsInvalidated: 4,
      findingsConfirmed: 5,
      findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
    });
    // The whole point: it is not silently promoted to either real source.
    expect(legacy).not.toMatchObject({
      findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
    });
    expect(legacy).not.toMatchObject({
      findingsProvenance: AgentComponentFindingsProvenance.TranscriptRecovered,
    });
  });

  // A stored label that serialized as JSON `null` is the same fact as an
  // absent one, and a nullable column is how a legacy row actually arrives.
  it("keeps the counts when the stored label is null", () => {
    expect(
      readAgentComponentFindingsFunnel({
        findingsEmitted: 3,
        findingsInvalidated: 1,
        findingsProvenance: null,
      })
    ).toEqual({
      state: AgentComponentFindingsFunnelState.Measured,
      findingsEmitted: 3,
      findingsInvalidated: 1,
      findingsConfirmed: 2,
      findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
    });
  });

  // A label this build has no descriptor for must not take two good counts
  // down with it. It is the same "cannot place this row" fact as an absent
  // label, so it reads the same way — listed, never dropped, never promoted.
  it("keeps the counts when the label itself is unrecognized", () => {
    const unknownLabel = readAgentComponentFindingsFunnel({
      findingsEmitted: 9,
      findingsInvalidated: 4,
      findingsProvenance: "future-route",
    });

    expect(unknownLabel).toEqual({
      state: AgentComponentFindingsFunnelState.Measured,
      findingsEmitted: 9,
      findingsInvalidated: 4,
      findingsConfirmed: 5,
      findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
    });
  });

  // ISS-10739 AC: the label is per count, not per population.
  it("keeps each reading's own label when two routes are folded together", () => {
    const readings = [
      readAgentComponentFindingsFunnel({
        findingsEmitted: 6,
        findingsInvalidated: 1,
        findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
      }),
      readAgentComponentFindingsFunnel({
        findingsEmitted: 4,
        findingsInvalidated: 2,
        findingsProvenance:
          AgentComponentFindingsProvenance.TranscriptRecovered,
      }),
    ];

    expect(readings.map((reading) => reading.state)).toEqual([
      AgentComponentFindingsFunnelState.Measured,
      AgentComponentFindingsFunnelState.Measured,
    ]);
    expect(
      readings.map((reading) =>
        reading.state === AgentComponentFindingsFunnelState.Measured
          ? reading.findingsProvenance
          : null
      )
    ).toEqual([
      AgentComponentFindingsProvenance.PluginEmitted,
      AgentComponentFindingsProvenance.TranscriptRecovered,
    ]);
  });
});

describe("AGENT_COMPONENT_FINDINGS_FUNNEL_INGEST_KEYS", () => {
  it("names the label among the keys a boundary must carry", () => {
    expect([...AGENT_COMPONENT_FINDINGS_FUNNEL_INGEST_KEYS].sort()).toEqual(
      [...EXPECTED_INGEST_KEYS].sort()
    );
  });
});

describe("isAgentComponentFindingsFunnel", () => {
  // ISS-10739 AC: a finding count without a source label is rejected rather
  // than defaulted. This pins the PREDICATE, which is the gate both sync
  // directions will call — the funnel is not yet on the sync item, so there is
  // no wired boundary to drive, and ISS-10726 owns calling this from one. What
  // enforces the label at the single producer that exists today is `tsc`, and
  // the attribution suite pins the value it writes.
  it("rejects a count with no source label instead of defaulting one", () => {
    expect(
      isAgentComponentFindingsFunnel({
        findingsEmitted: 7,
        findingsInvalidated: 2,
      })
    ).toBe(false);
    expect(
      isAgentComponentFindingsFunnel({
        findingsEmitted: 7,
        findingsInvalidated: 2,
        findingsProvenance: undefined,
      })
    ).toBe(false);
    expect(
      isAgentComponentFindingsFunnel({
        findingsEmitted: 7,
        findingsInvalidated: 2,
        findingsProvenance: "measured",
      })
    ).toBe(false);
    expect(
      isAgentComponentFindingsFunnel({
        findingsEmitted: 7,
        findingsInvalidated: 2,
        findingsProvenance:
          AgentComponentFindingsProvenance.TranscriptRecovered,
      })
    ).toBe(true);
  });

  // The ingest accepts a narrower set than the read: a producer writing the
  // read-side fallback would be indistinguishable from a legacy unlabelled
  // row, which is the one distinction that member exists to carry. Paired with
  // the presence half below, so a guard that rejected everything would fail.
  it("rejects the read-side fallback as a declared ingest route", () => {
    expect(
      isAgentComponentFindingsFunnel({
        findingsEmitted: 7,
        findingsInvalidated: 2,
        findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
      })
    ).toBe(false);
    expect(
      isAgentComponentFindingsFunnel({
        findingsEmitted: 7,
        findingsInvalidated: 2,
        findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
      })
    ).toBe(true);
    // ...and the READ still keeps that row's counts, reading the fallback it
    // was stored with rather than discarding two real numbers.
    expect(
      readAgentComponentFindingsFunnel({
        findingsEmitted: 7,
        findingsInvalidated: 2,
        findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
      })
    ).toEqual({
      state: AgentComponentFindingsFunnelState.Measured,
      findingsEmitted: 7,
      findingsInvalidated: 2,
      findingsConfirmed: 5,
      findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
    });
  });

  it("reads a kind that declares no findings output as not applicable, not unknown", () => {
    // ISS-10727: the third state. `none` is a ruling and `unclassified` is an
    // unanswered question, so only the ruling reaches NotApplicable.
    expect(readAgentComponentFindingsFunnel(null, true)).toEqual({
      state: "not_applicable",
    });
    expect(readAgentComponentFindingsFunnel(null, false)).toEqual({
      state: "unknown",
    });
    expect(readAgentComponentFindingsFunnel(null)).toEqual({
      state: "unknown",
    });
  });

  it("keeps a real measurement when the declaration says there should be none", () => {
    expect(
      readAgentComponentFindingsFunnel(
        { findingsEmitted: 3, findingsInvalidated: 1 },
        true
      )
    ).toEqual({
      state: "measured",
      findingsEmitted: 3,
      findingsInvalidated: 1,
      findingsConfirmed: 2,
      // ISS-10739 made the label mandatory on every Measured reading; this row
      // carries counts and no label, which is exactly `Unresolved`.
      findingsProvenance: AgentComponentFindingsProvenance.Unresolved,
    });
  });

  it("never mints not-applicable from an absence it cannot explain", () => {
    // ISS-10727: with no declaration passed, this fold sees a stored pair and
    // nothing else, so an absent one is Unknown and never the third state.
    // Whether a kind DECLARES no findings output is answered where that
    // declaration is read, and is covered at
    // `agentComponentInvocationFindingsFields`; the sibling case above pins
    // what this fold does when the caller passes that ruling explicitly.
    for (const absent of [null, undefined]) {
      expect(readAgentComponentFindingsFunnel(absent)).toEqual({
        state: AgentComponentFindingsFunnelState.Unknown,
      });
    }
  });
});

describe("agentComponentFindingsInvalidationRate", () => {
  it("carries the population it was measured over", () => {
    expect(
      agentComponentFindingsInvalidationRate([
        readAgentComponentFindingsFunnel({
          findingsEmitted: 8,
          findingsInvalidated: 2,
          findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
        }),
        readAgentComponentFindingsFunnel({
          findingsEmitted: 2,
          findingsInvalidated: 1,
          findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
        }),
        readAgentComponentFindingsFunnel(undefined),
      ])
    ).toEqual({
      known: true,
      rate: 0.3,
      findingsEmitted: 10,
      findingsInvalidated: 3,
      reportingComponents: 2,
      populationComponents: 3,
      bySource: {
        [AgentComponentFindingsProvenance.PluginEmitted]: {
          reportingComponents: 2,
          findingsEmitted: 10,
          findingsInvalidated: 3,
          representable: true,
        },
        [AgentComponentFindingsProvenance.TranscriptRecovered]: emptyTally(),
        [AgentComponentFindingsProvenance.Unresolved]: emptyTally(),
      },
    });
  });

  it("refuses a rate whose aggregate left the safe-integer range", () => {
    // Each reading is individually admissible; their sum is not, so the total
    // is already rounded and a rate derived from it is arithmetic noise.
    expect(
      agentComponentFindingsInvalidationRate([
        readAgentComponentFindingsFunnel({
          findingsEmitted: Number.MAX_SAFE_INTEGER,
          findingsInvalidated: 1,
          findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
        }),
        readAgentComponentFindingsFunnel({
          findingsEmitted: Number.MAX_SAFE_INTEGER,
          findingsInvalidated: 1,
          findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
        }),
      ])
    ).toMatchObject({
      known: false,
      reportingComponents: 2,
      populationComponents: 2,
      bySource: {
        // The bucket still publishes its count — a rounded total is a caveat,
        // not a reason to withhold — but it says the total is rounded rather
        // than handing a consumer the same noise the rate arm just refused.
        [AgentComponentFindingsProvenance.PluginEmitted]: {
          reportingComponents: 2,
          representable: false,
        },
      },
    });
  });

  it("refuses a rate with no denominator instead of reporting 0%", () => {
    expect(
      agentComponentFindingsInvalidationRate([
        readAgentComponentFindingsFunnel({
          findingsEmitted: 0,
          findingsInvalidated: 0,
          findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
        }),
        readAgentComponentFindingsFunnel(undefined),
      ])
    ).toEqual({
      known: false,
      reportingComponents: 1,
      populationComponents: 2,
      bySource: {
        [AgentComponentFindingsProvenance.PluginEmitted]: {
          reportingComponents: 1,
          findingsEmitted: 0,
          findingsInvalidated: 0,
          representable: true,
        },
        [AgentComponentFindingsProvenance.TranscriptRecovered]: emptyTally(),
        [AgentComponentFindingsProvenance.Unresolved]: emptyTally(),
      },
    });
  });

  // ISS-10739 AC: a published precision rate carries its per-source breakdown,
  // and the rate cannot be constructed without it.
  it("carries the breakdown on the unknown arm too, so no arm quotes a bare population", () => {
    const rate = agentComponentFindingsInvalidationRate([
      readAgentComponentFindingsFunnel({
        findingsEmitted: 0,
        findingsInvalidated: 0,
        findingsProvenance:
          AgentComponentFindingsProvenance.TranscriptRecovered,
      }),
    ]);

    expect(rate.known).toBe(false);
    expect(rate.bySource).toEqual({
      [AgentComponentFindingsProvenance.PluginEmitted]: emptyTally(),
      [AgentComponentFindingsProvenance.TranscriptRecovered]: {
        reportingComponents: 1,
        findingsEmitted: 0,
        findingsInvalidated: 0,
        representable: true,
      },
      [AgentComponentFindingsProvenance.Unresolved]: emptyTally(),
    });
  });

  // The Unresolved bucket is the one a fixture never reaches by accident: every
  // other expectation in this file writes it as empty. A rate measured over an
  // all-legacy population must say so, not publish a real percentage beside an
  // all-zero mix.
  it("routes an unlabelled legacy reading into the unresolved bucket", () => {
    const rate = agentComponentFindingsInvalidationRate([
      readAgentComponentFindingsFunnel({
        findingsEmitted: 4,
        findingsInvalidated: 1,
      }),
    ]);

    expect(rate).toEqual({
      known: true,
      rate: 0.25,
      findingsEmitted: 4,
      findingsInvalidated: 1,
      reportingComponents: 1,
      populationComponents: 1,
      bySource: {
        [AgentComponentFindingsProvenance.PluginEmitted]: emptyTally(),
        [AgentComponentFindingsProvenance.TranscriptRecovered]: emptyTally(),
        [AgentComponentFindingsProvenance.Unresolved]: {
          reportingComponents: 1,
          findingsEmitted: 4,
          findingsInvalidated: 1,
          representable: true,
        },
      },
    });
  });

  it("distinguishes two populations a bare rate would render identically", () => {
    const plugin = readAgentComponentFindingsFunnel({
      findingsEmitted: 5,
      findingsInvalidated: 1,
      findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
    });
    const transcript = readAgentComponentFindingsFunnel({
      findingsEmitted: 5,
      findingsInvalidated: 1,
      findingsProvenance: AgentComponentFindingsProvenance.TranscriptRecovered,
    });

    const allPlugin = agentComponentFindingsInvalidationRate([plugin, plugin]);
    const mixed = agentComponentFindingsInvalidationRate([plugin, transcript]);

    // Every published aggregate is identical between the two populations...
    expect(mixed).toMatchObject({
      known: true,
      rate: 0.2,
      findingsEmitted: 10,
      findingsInvalidated: 2,
      reportingComponents: 2,
      populationComponents: 2,
    });
    expect(allPlugin).toMatchObject({
      known: true,
      rate: 0.2,
      findingsEmitted: 10,
      findingsInvalidated: 2,
      reportingComponents: 2,
      populationComponents: 2,
    });
    // ...so the breakdown is the ONLY thing that keeps a reader from folding a
    // transcript-recovered count and a plugin-emitted one into one figure.
    expect(mixed.bySource).not.toEqual(allPlugin.bySource);
    expect(
      mixed.bySource[AgentComponentFindingsProvenance.TranscriptRecovered]
        .findingsEmitted
    ).toBe(5);
    expect(
      allPlugin.bySource[AgentComponentFindingsProvenance.TranscriptRecovered]
        .findingsEmitted
    ).toBe(0);
  });

  it("makes the breakdown non-optional on both arms of the published rate", () => {
    // A compile-time pin, not a runtime one: this object is the whole of what
    // the type permits, so deleting `bySource` from either arm stops this file
    // compiling. That is what "the rate cannot be constructed without it"
    // means — a consumer building one has no shape available that omits it.
    const arms: AgentComponentFindingsInvalidationRate[] = [
      {
        known: false,
        reportingComponents: 0,
        populationComponents: 0,
        bySource: {
          [AgentComponentFindingsProvenance.PluginEmitted]: emptyTally(),
          [AgentComponentFindingsProvenance.TranscriptRecovered]: emptyTally(),
          [AgentComponentFindingsProvenance.Unresolved]: emptyTally(),
        },
      },
      {
        known: true,
        rate: 0,
        findingsEmitted: 1,
        findingsInvalidated: 0,
        reportingComponents: 1,
        populationComponents: 1,
        bySource: {
          [AgentComponentFindingsProvenance.PluginEmitted]: {
            reportingComponents: 1,
            findingsEmitted: 1,
            findingsInvalidated: 0,
            representable: true,
          },
          [AgentComponentFindingsProvenance.TranscriptRecovered]: emptyTally(),
          [AgentComponentFindingsProvenance.Unresolved]: emptyTally(),
        },
      },
    ];

    for (const arm of arms) {
      expect(Object.keys(arm.bySource).sort()).toEqual(
        ["plugin-emitted", "transcript-recovered", "unresolved"].sort()
      );
    }
  });

  it("counts a not-applicable component in the population and not in the rate", () => {
    expect(
      agentComponentFindingsInvalidationRate([
        readAgentComponentFindingsFunnel({
          findingsEmitted: 4,
          findingsInvalidated: 1,
        }),
        { state: AgentComponentFindingsFunnelState.NotApplicable },
        readAgentComponentFindingsFunnel(null),
      ])
    ).toEqual({
      known: true,
      rate: 0.25,
      findingsEmitted: 4,
      findingsInvalidated: 1,
      reportingComponents: 1,
      populationComponents: 3,
      // ISS-10739 made `bySource` mandatory on BOTH arms. The one reporting
      // component carries no label, so its counts land in `unresolved`; the
      // not-applicable and unknown components report nothing anywhere.
      bySource: {
        [AgentComponentFindingsProvenance.PluginEmitted]: {
          reportingComponents: 0,
          findingsEmitted: 0,
          findingsInvalidated: 0,
          representable: true,
        },
        [AgentComponentFindingsProvenance.TranscriptRecovered]: {
          reportingComponents: 0,
          findingsEmitted: 0,
          findingsInvalidated: 0,
          representable: true,
        },
        [AgentComponentFindingsProvenance.Unresolved]: {
          reportingComponents: 1,
          findingsEmitted: 4,
          findingsInvalidated: 1,
          representable: true,
        },
      },
    });
  });
});

describe("storedAgentComponentFindingsFunnel", () => {
  it("reads a measured pair back from bigint cells", () => {
    expect(storedAgentComponentFindingsFunnel(10n, 3n)).toEqual({
      findingsEmitted: 10,
      findingsInvalidated: 3,
    });
  });

  it("reads a genuine zero as measured, not as absent", () => {
    expect(storedAgentComponentFindingsFunnel(0, 0)).toEqual({
      findingsEmitted: 0,
      findingsInvalidated: 0,
    });
  });

  it("reads a half-set pair as not measured, in EITHER direction", () => {
    expect(storedAgentComponentFindingsFunnel(10, null)).toBeNull();
    expect(storedAgentComponentFindingsFunnel(null, 3)).toBeNull();
  });

  it("refuses a blank cell rather than reading it as a measured zero", () => {
    // `Number("")` and `Number("  ")` are both 0; a coercing reader would
    // report a corrupt cell as a component that emitted nothing.
    expect(storedAgentComponentFindingsFunnel("", "")).toBeNull();
    expect(storedAgentComponentFindingsFunnel("  ", 0)).toBeNull();
  });

  it.each([
    ["negative emitted", -1, 0],
    ["negative invalidated", 5, -1],
    ["fractional emitted", 1.5, 0],
    ["fractional invalidated", 5, 1.5],
    ["emitted past the safe-integer range", Number.MAX_SAFE_INTEGER + 2, 0],
    ["non-finite emitted", Number.POSITIVE_INFINITY, 0],
    ["invalidated exceeding emitted", 2, 3],
  ])("refuses %s", (_label, emitted, invalidated) => {
    expect(storedAgentComponentFindingsFunnel(emitted, invalidated)).toBeNull();
  });

  it("refuses a corrupt text cell instead of emitting NaN", () => {
    expect(storedAgentComponentFindingsFunnel("seven", 0)).toBeNull();
  });
});

describe("readStoredAgentComponentFindingsCells", () => {
  it("separates a never-written pair from a corrupt one", () => {
    expect(readStoredAgentComponentFindingsCells(null, null)).toEqual({
      reading: AgentComponentFindingsCellsReading.Absent,
    });
    expect(readStoredAgentComponentFindingsCells(undefined, undefined)).toEqual(
      { reading: AgentComponentFindingsCellsReading.Absent }
    );
  });

  it.each([
    ["a half-set pair", 10, null],
    ["a half-set pair the other way", null, 3],
    ["a blank cell", "", 0],
    ["a corrupt text cell", "seven", 0],
    ["a negative count", -1, 0],
    ["a fractional count", 1.5, 0],
    ["an inverted pair", 2, 3],
  ])("reports %s as invalid rather than absent", (_label, a, b) => {
    expect(readStoredAgentComponentFindingsCells(a, b)).toEqual({
      reading: AgentComponentFindingsCellsReading.Invalid,
    });
  });

  it("reads a measured pair, zero included", () => {
    expect(readStoredAgentComponentFindingsCells(10n, 3n)).toEqual({
      reading: AgentComponentFindingsCellsReading.Measured,
      funnel: { findingsEmitted: 10, findingsInvalidated: 3 },
    });
    expect(readStoredAgentComponentFindingsCells(0, 0)).toEqual({
      reading: AgentComponentFindingsCellsReading.Measured,
      funnel: { findingsEmitted: 0, findingsInvalidated: 0 },
    });
  });
});

/**
 * ISS-11325 (@tamsinb review): the ONE fold both row->wire producers call.
 *
 * Its keep/drop call is a cross-process contract, not a local convenience: the
 * Desktop's `storedRowToSyncItem` and the cloud's row->wire projection both go
 * through it, and ingest rebuilds a generation id from the cloud's output to
 * reconcile against the hash the Desktop sent. A disagreement about one field is
 * a permanent `generation_conflict` for the whole generation.
 */
describe("storedAgentComponentFindingsWireProjection", () => {
  it("emits the pair with a disposition the pair agrees with", () => {
    expect(
      storedAgentComponentFindingsWireProjection(3n, 1n, "measured-this-run")
    ).toEqual({
      findingsEmitted: 3,
      findingsInvalidated: 1,
      findingsDisposition: AgentComponentFindingsDisposition.MeasuredThisRun,
    });
  });

  it("drops a disposition the emitted pair contradicts, keeping the pair", () => {
    expect(
      storedAgentComponentFindingsWireProjection(3n, 1n, "withheld-byte-gated")
    ).toEqual({ findingsEmitted: 3, findingsInvalidated: 1 });
  });

  it("drops a measuring disposition when the pair itself was dropped", () => {
    // A half-set pair emits neither count, so a `measured-this-run` label riding
    // along would claim a funnel the item does not carry.
    expect(
      storedAgentComponentFindingsWireProjection(3n, null, "measured-this-run")
    ).toEqual({});
  });

  it("emits a withholding on a row with no pair", () => {
    expect(
      storedAgentComponentFindingsWireProjection(
        null,
        null,
        "withheld-unreadable"
      )
    ).toEqual({
      findingsDisposition: AgentComponentFindingsDisposition.WithheldUnreadable,
    });
  });

  it("drops the read-side fallback and a member this build cannot place", () => {
    expect(
      storedAgentComponentFindingsWireProjection(null, null, "unrecorded")
    ).toEqual({});
    expect(
      storedAgentComponentFindingsWireProjection(
        null,
        null,
        "withheld-from-a-newer-build"
      )
    ).toEqual({});
    expect(
      storedAgentComponentFindingsWireProjection(null, null, null)
    ).toEqual({});
  });
});
