/**
 * ISS-10718: `succeeded` at the `.strict()` wire boundary.
 *
 * A `.strict()` object SILENTLY REJECTS THE WHOLE PAYLOAD on an unknown key, and
 * the in-process path skips the schema, so the producer's own tests never see
 * it. These cases drive the real schema — the new shape, the OLD shape without
 * the field, and the round trip — so a boundary that was never taught the key
 * fails here rather than in production, where it re-drops the same part on every
 * retry.
 */
import { describe, expect, it } from "vitest";
import { AgentComponentInvocationKind } from "../agent-component-invocation.ts";
import {
  item,
  part,
} from "../agent-component-invocation-schema.test-helpers.ts";
import {
  agentComponentInvocationSyncItemSchema,
  agentComponentInvocationSyncPartSchema,
} from "../agent-component-invocation-schema.ts";

/**
 * `succeeded` may only ride a kind something adjudicates. These cases use a
 * HOOK firing; the tool-result kinds have their own cases below.
 */
function hookItem(id: string) {
  return { ...item(id), kind: AgentComponentInvocationKind.Hook };
}

describe("succeeded at the strict wire boundary", () => {
  it("accepts an item carrying succeeded, in both directions", () => {
    for (const succeeded of [true, false]) {
      const parsed = agentComponentInvocationSyncItemSchema.safeParse({
        ...hookItem("invocation-1"),
        succeeded,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.succeeded).toBe(succeeded);
      }
    }
  });

  it("accepts the OLD shape, which omits the field entirely", () => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse(
      item("invocation-1")
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.hasOwn(parsed.data, "succeeded")).toBe(false);
    }
  });

  it("round-trips a succeeded-bearing part without losing the field", () => {
    const wire = {
      ...part([{ ...hookItem("invocation-1"), succeeded: false }]),
      // Literal 4, not the constant: the part must declare the version an older
      // API refuses retryably, and reading it through the constant would keep
      // this green after a renumber.
      protocolVersion: 4,
    };
    const parsed = agentComponentInvocationSyncPartSchema.safeParse(
      JSON.parse(JSON.stringify(wire))
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items[0]?.succeeded).toBe(false);
    }
  });

  // ISS-10718 (@whitlockk review): the kind gate, at the boundary that decides it.
  it("accepts a tool result's verdict on every tool-result kind", () => {
    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Orchestration,
    ]) {
      const parsed = agentComponentInvocationSyncItemSchema.safeParse({
        ...item("invocation-1"),
        kind,
        succeeded: false,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.succeeded).toBe(false);
      }
    }
  });

  it("holds a tool-result verdict on a part below v10 to the version gate", () => {
    const toolVerdict = {
      ...item("invocation-1"),
      kind: AgentComponentInvocationKind.Tool,
      succeeded: false,
    };
    // Literals, not the constants: an older API's supported set is numbers.
    for (const [protocolVersion, accepted] of [
      [9, false],
      [10, true],
    ] as const) {
      const parsed = agentComponentInvocationSyncPartSchema.safeParse(
        JSON.parse(JSON.stringify({ ...part([toolVerdict]), protocolVersion }))
      );
      expect(parsed.success).toBe(accepted);
    }
  });

  it("refuses a verdict on a kind nothing adjudicates", () => {
    for (const kind of [
      AgentComponentInvocationKind.Skill,
      AgentComponentInvocationKind.Subagent,
    ]) {
      const parsed = agentComponentInvocationSyncItemSchema.safeParse({
        ...item("invocation-1"),
        kind,
        succeeded: true,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some(
            (issue) =>
              issue.message === "succeeded_requires_success_bearing_kind"
          )
        ).toBe(true);
      }
    }
  });

  /**
   * ISS-10718 (@whitlockk review): the regression a version ABOVE v3 makes possible.
   *
   * `storedSubagentUsage` keeps the counts of a legacy row whose
   * `usage_measurement` predates the label, and the boundary accepts that shape
   * on a v2 part. One hook item carrying `succeeded` lifts the SAME part to v4,
   * and gating the label rule on the declared version would then demand a label
   * of that legacy row — a verdict `assertPartSatisfiesWireContract` raises on
   * the device, dead-lettering every row in the generation over a field none of
   * them carry.
   */
  it("does not retroactively demand a label of a legacy row", () => {
    // A usage-bearing kind, unlabelled: the pre-ISS-7795 shape on disk.
    const legacy = {
      ...item("invocation-1"),
      kind: AgentComponentInvocationKind.Subagent,
      inputTokens: 10,
    };
    const verdict = { ...hookItem("invocation-2"), succeeded: true };
    const parsed = agentComponentInvocationSyncPartSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          ...part([legacy, verdict]),
          protocolVersion: 4,
        })
      )
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual([]);
    }
  });

  it("still holds a producer that DECLARES the label version to it", () => {
    const parsed = agentComponentInvocationSyncPartSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          ...part([
            {
              ...item("invocation-1"),
              kind: AgentComponentInvocationKind.Subagent,
              inputTokens: 10,
            },
          ]),
          protocolVersion: 3,
        })
      )
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (issue) => issue.message === "telemetry_requires_usage_measurement"
        )
      ).toBe(true);
    }
  });

  it("still rejects a key the boundary was never taught", () => {
    const parsed = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("invocation-1"),
      succeededAt: "2026-09-23T00:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });
});
