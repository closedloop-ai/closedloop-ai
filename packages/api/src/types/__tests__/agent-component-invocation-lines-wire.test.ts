/**
 * @file agent-component-invocation-lines-wire.test.ts
 * @description ISS-10730 — the `.strict()` ingest boundary's half of the
 * line-attribution contract: which kinds may carry a delta, which values are
 * storable, and which protocol version a line-carrying part must declare.
 *
 * The version gate is the load-bearing one. An API carrying ISS-7795 but not
 * this change ACCEPTS a v3 declaration and only then rejects `linesAdded` as an
 * unknown key — a 400 the Desktop client classes PERMANENT, which drops the
 * whole generation after five attempts. Declaring a version that API does not
 * know trips its version gate instead, which is retryable.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
  AgentComponentInvocationKind,
  type AgentComponentInvocationSyncProtocolVersion,
  agentComponentInvocationSyncProtocolVersionForItems,
} from "../agent-component-invocation.ts";
import {
  item,
  part,
} from "../agent-component-invocation-schema.test-helpers.ts";
import { agentComponentInvocationSyncBatchSchema } from "../agent-component-invocation-schema.ts";

function linePart(
  items: unknown[],
  protocolVersion: AgentComponentInvocationSyncProtocolVersion = AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION
) {
  return { ...part(items), protocolVersion };
}

function parse(
  items: unknown[],
  protocolVersion?: AgentComponentInvocationSyncProtocolVersion
) {
  return agentComponentInvocationSyncBatchSchema.safeParse({
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION,
    parts: [linePart(items, protocolVersion)],
  });
}

function messages(parsed: ReturnType<typeof parse>): string[] {
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
}

describe("invocation line attribution on the wire", () => {
  /**
   * The wire number itself, as a NON-CIRCULAR literal.
   *
   * Every other case here reaches the version through the constant, so a
   * renumber leaves them all green — which is precisely the shape that lets a
   * second producer claim the same number unnoticed. A wire version is an
   * IDENTITY: ISS-10718 (#7804) merged v4 for `succeeded` and ISS-10725 (#7715)
   * merged v5 for the findings funnel, so lines took the next free number at
   * merge time and nothing may quietly move it again.
   *
   * The supported list is spelled out for the same reason, and guards the
   * MERGE: a resolution that keeps one side's list instead of UNIONING both
   * drops a version a peer is already shipping, and the ladder must have no
   * holes because declaring N asserts this build understands every field
   * introduced at or below N. That row reddens here.
   */
  it("pins the wire version and the supported set to their literal values", () => {
    expect(AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION).toBe(6);
    const supported: number[] = [
      ...AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
    ];
    // ISS-10720 added v7 (the OTel evidence class / attribution source) and
    // ISS-11325 added v8 (the findings disposition) above this lane's v6. The
    // literal is EXTENDED, never replaced: dropping a version a peer already
    // ships makes the ingest gate answer `protocol_unsupported` forever for a
    // producer doing nothing wrong.
    expect(supported.sort((left, right) => left - right)).toStrictEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  /**
   * The version a part declares is the HIGHEST any of its fields introduced, so
   * an item carrying lines alongside a lower-versioned field must still reach
   * v6. Pinned because the merge that renumbered lines split the derivation in
   * two — a usage-only helper and the full ladder — and putting the lines arm in
   * the usage helper made a lines-plus-findings part derive v5, clear a
   * deployed route's version gate, and then be refused by its `.strict()` item
   * schema: the permanent `validation_failed` dead letter the constant exists
   * to prevent.
   */
  it("derives the lines version for a part that also carries a lower-version field", () => {
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { ...item("toolu_a"), linesAdded: 12, linesRemoved: 4 },
        { ...item("toolu_b"), findingsEmitted: 10, findingsInvalidated: 3 },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION);
  });

  it("accepts a delta on a tool-kind item", () => {
    expect(
      parse([{ ...item("toolu_a"), linesAdded: 12, linesRemoved: 4 }]).success
    ).toBe(true);
  });

  /**
   * TWO items with DIFFERENT deltas, so this cannot pass on a single global
   * number: the boundary must carry each invocation's own attribution through.
   */
  it("carries each invocation's own delta, not one shared number", () => {
    const parsed = parse([
      { ...item("toolu_a"), linesAdded: 12, linesRemoved: 4 },
      { ...item("toolu_b"), linesAdded: 3, linesRemoved: 90 },
    ]);
    expect(parsed.success).toBe(true);
    const items = parsed.success ? parsed.data.parts[0].items : [];
    expect(items.map((entry) => entry.linesAdded)).toStrictEqual([12, 3]);
    expect(items.map((entry) => entry.linesRemoved)).toStrictEqual([4, 90]);
  });

  it("rejects a delta on a kind nothing measures lines for", () => {
    const parsed = parse([
      {
        ...item("toolu_a"),
        kind: AgentComponentInvocationKind.Subagent,
        linesAdded: 12,
        linesRemoved: 4,
      },
    ]);
    expect(messages(parsed)).toContain("lines_require_line_bearing_kind");
  });

  it("rejects an item carrying only the added half of a delta", () => {
    const parsed = parse([{ ...item("toolu_a"), linesAdded: 12 }]);
    expect(messages(parsed)).toContain("lines_require_both_halves");
  });

  it("rejects an item carrying only the removed half of a delta", () => {
    const parsed = parse([{ ...item("toolu_a"), linesRemoved: 4 }]);
    expect(messages(parsed)).toContain("lines_require_both_halves");
  });

  it("accepts an item carrying NEITHER half", () => {
    const parsed = parse([item("toolu_a")]);
    expect(parsed.success).toBe(true);
  });

  it("accepts a zero/zero delta — a call that changed nothing is not a half-written row", () => {
    const parsed = parse([
      { ...item("toolu_a"), linesAdded: 0, linesRemoved: 0 },
    ]);
    expect(parsed.success).toBe(true);
  });

  it("rejects a fractional line count", () => {
    const parsed = parse([
      { ...item("toolu_a"), linesAdded: 1.5, linesRemoved: 0 },
    ]);
    expect(messages(parsed)).toContain("invalid_line_count");
  });

  it("requires a line-carrying part to declare the lines protocol version", () => {
    const parsed = parse(
      [{ ...item("toolu_a"), linesAdded: 12, linesRemoved: 4 }],
      AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION
    );
    expect(messages(parsed)).toContain("telemetry_requires_protocol_version");
  });

  it("keeps a line-free part on the version it already declared", () => {
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([item("toolu_a")])
    ).toBeLessThan(AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { ...item("toolu_a"), linesAdded: 1, linesRemoved: 0 },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION);
  });
});
