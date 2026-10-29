import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
  AgentComponentInvocationKind,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPartWithoutHash,
  type AgentComponentInvocationSyncProtocolVersion,
  AgentComponentInvocationUsageMeasurement,
  agentComponentInvocationSyncPartHashPreimage,
  agentComponentInvocationSyncProtocolVersionForItems,
  isSupportedAgentComponentInvocationSyncProtocolVersion,
} from "../agent-component-invocation.ts";
import {
  item,
  part,
} from "../agent-component-invocation-schema.test-helpers.ts";
import {
  agentComponentInvocationSyncBatchSchema,
  agentComponentInvocationSyncItemSchema,
} from "../agent-component-invocation-schema.ts";

/**
 * ISS-10726: the protocol versions an API that predates this change accepts.
 *
 * Written as bare literals ON PURPOSE. Built from
 * `AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS` minus v5 it
 * would agree with whatever this build currently declares, so a v5 accidentally
 * folded into the old set would keep this suite green — the exact mutation the
 * skew cases below exist to kill.
 */
const PRE_ISS10725_SUPPORTED_VERSIONS: readonly number[] = [1, 2, 3];

/** The gate a deployed older route applies BEFORE its `.strict()` parse. */
function olderApiRefusesVersionOutright(protocolVersion: number): boolean {
  return !PRE_ISS10725_SUPPORTED_VERSIONS.includes(protocolVersion);
}

function findingsItem(
  externalInvocationId: string,
  findingsEmitted: number,
  findingsInvalidated: number
) {
  return {
    ...item(externalInvocationId),
    findingsEmitted,
    findingsInvalidated,
  };
}

function findingsPart(items: unknown[]) {
  return {
    ...part(items),
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION,
  };
}

/** A part whose `items` are typed, so the hash preimage helper accepts it. */
function hashablePart(
  items: AgentComponentInvocationSyncItem[],
  protocolVersion: AgentComponentInvocationSyncProtocolVersion
): AgentComponentInvocationSyncPartWithoutHash {
  const { partHash: _partHash, ...rest } = part(items);
  return { ...rest, protocolVersion, items };
}

function batch(builtPart: ReturnType<typeof findingsPart>) {
  return {
    protocolVersion: builtPart.protocolVersion,
    parts: [builtPart],
  };
}

describe("findings funnel on the invocation sync protocol", () => {
  it("declares version 4 and accepts a part whose items carry findings", () => {
    // Two items with DIFFERENT pairs: one item cannot tell a per-item
    // projection from a part-wide constant.
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse(
      batch(
        findingsPart([
          findingsItem("invocation-1", 10, 3),
          findingsItem("invocation-2", 4, 0),
        ])
      )
    );

    expect(parsed.success).toBe(true);
    expect(parsed.data?.parts[0]?.items[0]).toMatchObject({
      findingsEmitted: 10,
      findingsInvalidated: 3,
    });
    expect(parsed.data?.parts[0]?.items[1]).toMatchObject({
      findingsEmitted: 4,
      findingsInvalidated: 0,
    });
  });

  it("puts version 5 in the supported set and answers the membership test", () => {
    expect(AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION).toBe(5);
    expect(
      AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS
    ).toContain(5);
    expect(isSupportedAgentComponentInvocationSyncProtocolVersion(5)).toBe(
      true
    );
    // ISS-10718's v4 is UNIONED, never replaced: the ladder has no holes.
    expect(
      AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS
    ).toContain(4);
  });

  it("chooses the version per part from its own items", () => {
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        findingsItem("invocation-1", 1, 0),
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION);
    // A findings-free part is unchanged by this ticket, at BOTH the versions
    // that already existed, so an older API still accepts it as it does today.
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        item("invocation-1"),
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        {
          ...item("invocation-1"),
          kind: AgentComponentInvocationKind.Subagent,
          inputTokens: 100,
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
        },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION);
  });

  it("moves to v5 on a HALF-set pair too, so the skew answer is the retryable one", () => {
    // An item carrying only `findingsInvalidated` is still a findings-carrying
    // item. Were the version chosen on "both keys present", it would declare v3
    // and an older API would take it to its `.strict()` schema and answer the
    // PERMANENT 400 rather than the retryable 501.
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { ...item("invocation-1"), findingsInvalidated: 1 },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION);
  });

  it("refuses a findings part that UNDER-declares its version", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
      parts: [
        {
          ...part([findingsItem("invocation-1", 2, 1)]),
          protocolVersion:
            AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
        },
      ],
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.message === "telemetry_requires_protocol_version"
      )
    ).toBe(true);
  });

  it("makes an older API answer protocol_unsupported, never validation_failed", () => {
    const declared = agentComponentInvocationSyncProtocolVersionForItems([
      findingsItem("invocation-1", 10, 3),
    ]);

    // What this change buys: the older route's pre-parse version gate turns the
    // part away (HTTP 501 -> `unavailable` -> retried forever).
    expect(olderApiRefusesVersionOutright(declared)).toBe(true);
    // What it avoids: v3 is a version that route ACCEPTS, so a part declaring
    // it would fall through to the `.strict()` item schema, be rejected there
    // for an unknown key, and dead-letter the generation permanently.
    expect(
      olderApiRefusesVersionOutright(
        AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION
      )
    ).toBe(false);
  });

  it("does not retroactively tighten the v3 telemetry-label rule", () => {
    // Bug Hunter A, ISS-10726. A pre-ISS-7795 row ships counts with no label,
    // and `storedSubagentUsage` deliberately still emits it. Before this guard,
    // one sibling carrying a funnel pushed the part to v5 and the `>= v3` label
    // rule then failed that legacy item as `telemetry_requires_usage_measurement`
    // — a permanent 400 taking the whole generation with it.
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse(
      batch(
        findingsPart([
          findingsItem("invocation-1", 10, 3),
          {
            ...item("invocation-2"),
            kind: AgentComponentInvocationKind.Subagent,
            inputTokens: 100,
          },
        ])
      )
    );

    expect(parsed.success).toBe(true);
  });

  it("still requires the label once the part's own telemetry asks for it", () => {
    // The rule is relaxed only where the version was driven by findings. A
    // producer that labelled one telemetry item and left another unlabelled is
    // inconsistent, and that is still rejected.
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse(
      batch(
        findingsPart([
          {
            ...item("invocation-1"),
            kind: AgentComponentInvocationKind.Subagent,
            inputTokens: 100,
            usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
          },
          {
            ...item("invocation-2"),
            kind: AgentComponentInvocationKind.Subagent,
            inputTokens: 200,
            findingsEmitted: 1,
            findingsInvalidated: 0,
          },
        ])
      )
    );

    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.message === "telemetry_requires_usage_measurement"
      )
    ).toBe(true);
  });

  it("omits an absent pair from the hash preimage rather than nulling it", () => {
    const preimage = agentComponentInvocationSyncPartHashPreimage(
      hashablePart(
        [item("invocation-1")],
        AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION
      )
    );

    expect(preimage).not.toContain("findingsEmitted");
    expect(preimage).not.toContain("findingsInvalidated");
    expect(preimage).not.toContain("null");
  });

  it("rejects an explicit null where omission is the contract", () => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("invocation-1"),
      findingsEmitted: null,
      findingsInvalidated: null,
    });

    expect(parsed.success).toBe(false);
  });

  it("reconciles the part hash with the new fields present", () => {
    const built = findingsPart([findingsItem("invocation-1", 10, 3)]);
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse(
      batch(built)
    );
    const parsedPart = parsed.data?.parts[0];

    expect(parsedPart).toBeDefined();
    // The API hashes the PARSED object; a boundary that reshaped the pair would
    // sign a different preimage and fail post-ingest reconciliation forever.
    expect(
      parsedPart === undefined
        ? null
        : agentComponentInvocationSyncPartHashPreimage(parsedPart)
    ).toBe(
      agentComponentInvocationSyncPartHashPreimage(
        hashablePart(
          [findingsItem("invocation-1", 10, 3)],
          AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_PROTOCOL_VERSION
        )
      )
    );
  });
});

describe("findings funnel validity at the ingest boundary", () => {
  it.each([
    ["emitted without invalidated", { findingsEmitted: 3 }],
    ["invalidated without emitted", { findingsInvalidated: 3 }],
  ])("rejects a half-set pair: %s", (_label, half) => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("invocation-1"),
      ...half,
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.message === "findings_pair_incomplete"
      )
    ).toBe(true);
  });

  it("rejects an invalidated count that exceeds emitted", () => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse(
      findingsItem("invocation-1", 2, 3)
    );

    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.message === "findings_invalidated_exceeds_emitted"
      )
    ).toBe(true);
  });

  it.each([
    ["negative", -1, 0],
    ["fractional", 1.5, 0],
    ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 2, 0],
    ["non-finite", Number.POSITIVE_INFINITY, 0],
  ])("rejects a %s count", (_label, emitted, invalidated) => {
    expect(
      agentComponentInvocationSyncItemSchema.safeParse(
        findingsItem("invocation-1", emitted, invalidated)
      ).success
    ).toBe(false);
  });

  it("rejects a blank string rather than coercing it to a measured zero", () => {
    expect(
      agentComponentInvocationSyncItemSchema.safeParse({
        ...item("invocation-1"),
        findingsEmitted: "",
        findingsInvalidated: "",
      }).success
    ).toBe(false);
  });

  it("accepts a genuine measured zero", () => {
    expect(
      agentComponentInvocationSyncItemSchema.safeParse(
        findingsItem("invocation-1", 0, 0)
      ).success
    ).toBe(true);
  });
});
