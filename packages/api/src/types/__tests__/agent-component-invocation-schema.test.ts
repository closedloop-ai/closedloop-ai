import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
  agentComponentInvocationSyncProtocolVersionForItems,
  hasAgentComponentInvocationTelemetry,
} from "../agent-component-invocation.ts";
import {
  item,
  part,
} from "../agent-component-invocation-schema.test-helpers.ts";
import { agentComponentInvocationSyncBatchSchema } from "../agent-component-invocation-schema.ts";
import { PR_INT_MAX } from "../session-artifact-link.ts";

describe("agent component invocation sync schema", () => {
  it("accepts a dedicated empty complete generation independently of session v2", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [part([])],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts branch context on an unresolved non-versionable occurrence", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [
        part([
          {
            ...item("invocation-1"),
            repositoryFullName: "closedloop-ai/closedloop-ai",
            branchName: "feat/fea-3294",
          },
        ]),
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts an additive transcript file identity on agent anchors", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [
        part([
          {
            ...item("invocation-1"),
            anchor: {
              kind: AgentComponentInvocationAnchorKind.Agent,
              agentId: "local-agent-1",
              externalAgentId: "provider-agent-1",
              transcriptFileId: "agent-transcript-1",
            },
          },
        ]),
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects version attribution on tool, MCP, and orchestration occurrences", () => {
    for (const kind of NON_DEFINITION_INVOCATION_KINDS) {
      const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [
          part([
            {
              ...item("invocation-1"),
              kind,
              status: AgentComponentInvocationAttributionStatus.Matched,
              definitionHash: "b".repeat(64),
              normalizerContractVersion: 1,
            },
          ]),
        ],
      });
      expect(parsed.success).toBe(false);
      expect(
        parsed.error?.issues.some(
          (issue) => issue.message === "non_definition_kind_must_be_unresolved"
        )
      ).toBe(true);
    }
  });

  it("rejects every non-Unresolved status on a non-definition kind even without provenance", () => {
    expect(NON_UNRESOLVED_ATTRIBUTION_STATUSES).not.toHaveLength(0);

    for (const kind of NON_DEFINITION_INVOCATION_KINDS) {
      for (const status of NON_UNRESOLVED_ATTRIBUTION_STATUSES) {
        const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          parts: [
            part([
              {
                ...item("invocation-1"),
                kind,
                status,
              },
            ]),
          ],
        });
        expect(parsed.success).toBe(false);
        expect(
          parsed.error?.issues.some(
            (issue) =>
              issue.message === "non_definition_kind_must_be_unresolved"
          )
        ).toBe(true);
        expect(
          parsed.error?.issues.some(
            (issue) =>
              issue.message === "non_definition_kind_has_provenance_evidence"
          )
        ).toBe(false);
      }
    }
  });

  it("rejects all provenance evidence on non-versionable occurrences", () => {
    const provenanceFields: Record<string, unknown>[] = [
      {
        evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
      },
      { definitionHash: "b".repeat(64) },
      { normalizerContractVersion: 1 },
      { definitionContent: "definition" },
      { definitionFormat: "markdown" },
      { sourcePath: "skills/review/SKILL.md" },
      { sourceModifiedAt: "2026-07-22T15:59:00.000Z" },
      { capturedAt: "2026-07-22T16:00:01.000Z" },
      { repositoryCommit: "abc123" },
      { packId: "pack-1" },
    ];

    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Orchestration,
    ]) {
      for (const provenance of provenanceFields) {
        const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          parts: [
            part([
              {
                ...item("invocation-1"),
                ...provenance,
                kind,
              },
            ]),
          ],
        });

        expect(parsed.success).toBe(false);
      }
    }
  });

  it("rejects null optional fields and duplicate invocation ids", () => {
    const withNull = {
      ...item("invocation-1"),
      childSessionId: null,
    };
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [part([withNull])],
      }).success
    ).toBe(false);

    const duplicate = item("same");
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [part([duplicate, duplicate])],
      }).success
    ).toBe(false);
  });

  it("rejects an empty part inside a multipart generation", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [{ ...part([]), partCount: 2 }],
      }).success
    ).toBe(false);
  });

  it("rejects multiple independently acknowledged parts in one request", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [part([]), part([])],
      }).success
    ).toBe(false);
  });

  it("rejects subagent-only usage on a non-subagent kind and keeps footprint kind-agnostic", () => {
    const usageFields = [
      { model: "claude-opus-4" },
      { inputTokens: 10 },
      { outputTokens: 10 },
      { cacheReadTokens: 10 },
      { cacheWriteTokens: 10 },
      { estimatedCost: 0.5 },
    ];

    for (const usage of usageFields) {
      const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
        parts: [
          measurementPart([{ ...measuredItem("invocation-1"), ...usage }]),
        ],
      });

      expect(parsed.success).toBe(false);
      // ISS-7795 supplies `usageMeasurement`, so the ONLY rule left to trip is
      // the kind gate; without this the assertion would pass on the new
      // telemetry-labelling rule and stop policing the one it names.
      expect(
        parsed.error?.issues.some(
          (issue) => issue.message === "subagent_usage_requires_subagent_kind"
        )
      ).toBe(true);
    }

    // footprintTokens is the kind-agnostic context-footprint metric.
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
        parts: [
          measurementPart([
            { ...measuredItem("invocation-1"), footprintTokens: 512 },
          ]),
        ],
      }).success
    ).toBe(true);
  });

  it("accepts subagent-turn usage on a subagent invocation", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
        parts: [
          measurementPart([
            {
              ...measuredItem("invocation-1"),
              kind: AgentComponentInvocationKind.Subagent,
              inputTokens: 100,
              outputTokens: 20,
              estimatedCost: 0.1255,
              model: "claude-opus-4",
            },
          ]),
        ],
      }).success
    ).toBe(true);
  });

  it("rejects telemetry declared under the telemetry-free protocol version", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [
        part([{ ...measuredItem("invocation-1"), footprintTokens: 512 }]),
      ],
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.message === "telemetry_requires_protocol_version"
      )
    ).toBe(true);
  });

  it("still accepts a telemetry-free part on the v1 protocol version", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [part([item("invocation-1")])],
      }).success
    ).toBe(true);
  });

  it("rejects an envelope whose version understates the part it carries", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [
          telemetryPart([
            { ...measuredItem("invocation-1"), footprintTokens: 512 },
          ]),
        ],
      }).success
    ).toBe(false);
  });

  it("pins the measurement vocabulary to exactly measured and estimated", () => {
    // Written independently of the const under test: deriving this from the
    // const would stay green if a member were deleted or its value reworded,
    // and the wire value is what a persisted row and every reader agree on.
    expect({ ...AgentComponentInvocationUsageMeasurement }).toEqual({
      Measured: "measured",
      Estimated: "estimated",
    });
  });

  it("rejects a v3 telemetry value whose measurement method is unstated", () => {
    // v3 is the version that INTRODUCED the label, so a producer declaring it
    // is asserting it can supply one. Omitting it there is the undifferentiated
    // column ISS-7795 exists to prevent.
    for (const telemetry of UNLABELLED_TELEMETRY_SHAPES) {
      const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
        parts: [measurementPart([{ ...item("invocation-1"), ...telemetry }])],
      });

      expect(parsed.success).toBe(false);
      expect(
        parsed.error?.issues.some(
          (issue) => issue.message === "telemetry_requires_usage_measurement"
        )
      ).toBe(true);
    }
  });

  it("accepts a v2 telemetry value whose measurement method is unstated", () => {
    // ISS-7795 (codex P1 review): v2 is still in
    // AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS, so an
    // already-installed or external producer that predates the label keeps
    // sending exactly these parts. Requiring the label of them returned HTTP
    // 400 `validation_failed`, which the Desktop client classes PERMANENT and
    // dead-letters after five attempts — silent data loss, not a retry.
    for (const telemetry of UNLABELLED_TELEMETRY_SHAPES) {
      const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
        parts: [telemetryPart([{ ...item("invocation-1"), ...telemetry }])],
      });

      expect(parsed.success).toBe(true);
    }
  });

  it("keeps a v2 telemetry item's absent label ABSENT rather than nulling it", () => {
    // The wire contract is omission, not `null`: a parsed item that grew a
    // `usageMeasurement: null` key would be re-serialized as one, and the
    // hashes the producer and the API each compute would stop reconciling.
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
      parts: [
        telemetryPart([{ ...item("invocation-1"), footprintTokens: 512 }]),
      ],
    });

    expect(parsed.success).toBe(true);
    const [parsedItem] = parsed.data?.parts[0].items ?? [];
    expect(Object.hasOwn(parsedItem ?? {}, "usageMeasurement")).toBe(false);
  });

  it("accepts the same telemetry once its measurement method is stated", () => {
    for (const measurement of [
      AgentComponentInvocationUsageMeasurement.Measured,
      AgentComponentInvocationUsageMeasurement.Estimated,
    ]) {
      expect(
        agentComponentInvocationSyncBatchSchema.safeParse({
          protocolVersion:
            AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
          parts: [
            measurementPart([
              {
                ...item("invocation-1"),
                footprintTokens: 512,
                usageMeasurement: measurement,
              },
            ]),
          ],
        }).success
      ).toBe(true);
    }
  });

  /**
   * ISS-10736 AC6. The converse of the case below, for the footprint specifically:
   * once a part declares the measurement protocol version, a footprint cannot be
   * written without the label saying how it was arrived at. This is what stops a
   * derived count and a provider-reported one sharing an unlabelled column.
   */
  it("rejects a footprint carrying no measurement method at v3", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
      parts: [
        measurementPart([{ ...item("invocation-1"), footprintTokens: 512 }]),
      ],
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.message === "telemetry_requires_usage_measurement"
      )
    ).toBe(true);
  });

  it("rejects a measurement method asserted about no telemetry at all", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [part([measuredItem("invocation-1")])],
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.message === "usage_measurement_requires_telemetry"
      )
    ).toBe(true);
  });

  it("rejects a measurement method it does not recognize", () => {
    // A later protocol revision naming a third method must not be accepted by
    // this build as if it were one of the two it can actually interpret.
    for (const unknown of ["sampled", "MEASURED", ""]) {
      expect(
        agentComponentInvocationSyncBatchSchema.safeParse({
          protocolVersion:
            AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
          parts: [
            telemetryPart([
              {
                ...item("invocation-1"),
                footprintTokens: 512,
                usageMeasurement: unknown,
              },
            ]),
          ],
        }).success
      ).toBe(false);
    }
  });

  it("rejects an explicitly null measurement method", () => {
    // Omission is the contract; a producer serializing `null` instead must be
    // rejected rather than read as "absent", the same as every other optional.
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
        parts: [
          telemetryPart([
            {
              ...item("invocation-1"),
              footprintTokens: 512,
              usageMeasurement: null,
            },
          ]),
        ],
      }).success
    ).toBe(false);
  });

  it("keeps the measurement label out of the telemetry-presence test", () => {
    // The label is not itself telemetry: were it counted, the pairing rule that
    // rejects a label asserted about nothing could never fire.
    expect(hasAgentComponentInvocationTelemetry(measuredItem("a"))).toBe(false);
  });

  it("declares the measurement version for any part carrying the label", () => {
    // The label is a field an API deployed before ISS-7795 would reject as an
    // unknown key on its strict schema — a PERMANENT dead-letter. Declaring v3
    // makes that API answer the retryable `protocol_unsupported` instead.
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([measuredItem("a")])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { ...item("a"), footprintTokens: 1, usageMeasurement: "measured" },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION);
  });

  it("derives the protocol version a part must declare from its own items", () => {
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([item("a")])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { ...item("a"), footprintTokens: 1 },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION);
  });

  // ── ISS-8329 §2: int4 ceiling on wire integers ──────────────────────

  it("accepts dataRevision at exactly int4 max", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [{ ...part([item("inv-1")]), dataRevision: PR_INT_MAX }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects dataRevision above int4 max", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [{ ...part([item("inv-1")]), dataRevision: PR_INT_MAX + 1 }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path.includes("dataRevision"))
      ).toBe(true);
    }
  });

  it("accepts sourceSequence at exactly int4 max", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [{ ...part([item("inv-1")]), sourceSequence: PR_INT_MAX }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects sourceSequence above int4 max", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [{ ...part([item("inv-1")]), sourceSequence: PR_INT_MAX + 1 }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path.includes("sourceSequence"))
      ).toBe(true);
    }
  });

  it("accepts items[].sequence at exactly int4 max", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [part([{ ...item("inv-1"), sequence: PR_INT_MAX }])],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects items[].sequence above int4 max", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [part([{ ...item("inv-1"), sequence: PR_INT_MAX + 1 }])],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes("sequence"))).toBe(
        true
      );
    }
  });

  it("accepts normalizerContractVersion at exactly int4 max", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [
        part([
          {
            ...item("inv-1"),
            kind: AgentComponentInvocationKind.Skill,
            status: AgentComponentInvocationAttributionStatus.Matched,
            definitionHash: "b".repeat(64),
            normalizerContractVersion: PR_INT_MAX,
          },
        ]),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects normalizerContractVersion above int4 max", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [
        part([
          {
            ...item("inv-1"),
            kind: AgentComponentInvocationKind.Skill,
            status: AgentComponentInvocationAttributionStatus.Matched,
            definitionHash: "b".repeat(64),
            normalizerContractVersion: PR_INT_MAX + 1,
          },
        ]),
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) =>
          i.path.includes("normalizerContractVersion")
        )
      ).toBe(true);
    }
  });
});

/**
 * ISS-7795: one telemetry shape per population the label covers — the
 * kind-agnostic footprint metric and both flavours of subagent-turn usage — so
 * the v2-accepted and v3-rejected cases are proved over the SAME inputs and
 * cannot drift into testing two different contracts.
 */
const NON_DEFINITION_INVOCATION_KINDS = [
  AgentComponentInvocationKind.Tool,
  AgentComponentInvocationKind.Mcp,
  AgentComponentInvocationKind.Orchestration,
] as const;

// Derived from the canonical const so a status added to
// AgentComponentInvocationAttributionStatus is covered here without an edit —
// a hand-listed set would silently stop pinning the rule's whole domain.
const NON_UNRESOLVED_ATTRIBUTION_STATUSES = Object.values(
  AgentComponentInvocationAttributionStatus
).filter(
  (status) => status !== AgentComponentInvocationAttributionStatus.Unresolved
);

const UNLABELLED_TELEMETRY_SHAPES = [
  { footprintTokens: 512 },
  { inputTokens: 100, kind: AgentComponentInvocationKind.Subagent },
  { estimatedCost: 0.1255, kind: AgentComponentInvocationKind.Subagent },
];

/**
 * ISS-7795: an item already carrying the measurement label, so a test about
 * some OTHER rule is not silently satisfied by the labelling rule instead.
 */
function measuredItem(externalInvocationId: string) {
  return {
    ...item(externalInvocationId),
    usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
  };
}

function measurementPart(items: unknown[]) {
  return {
    ...part(items),
    protocolVersion:
      AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  };
}

function telemetryPart(items: unknown[]) {
  return {
    ...part(items),
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  };
}
