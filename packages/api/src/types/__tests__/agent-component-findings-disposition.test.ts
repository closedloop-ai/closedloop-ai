/**
 * ISS-11325: the disposition vocabulary's own folds, in isolation.
 *
 * The persisted-row coverage is
 * `apps/desktop/test/component-invocations-findings-disposition.test.ts`, which
 * drives the real importer; these cases pin the decisions that file cannot
 * exercise every branch of — the ambiguity rule at every arity, the ingest/read
 * split, and the consistency predicate in both directions.
 */
import { describe, expect, test } from "vitest";
import {
  AgentComponentFindingsDisposition,
  agentComponentFindingsDispositionLabel,
  agentComponentFindingsWithheldDisposition,
  isAgentComponentFindingsDisposition,
  isAgentComponentFindingsDispositionConsistentWithFunnel,
  isAgentComponentFindingsIngestDisposition,
  readAgentComponentFindingsDisposition,
} from "../agent-component-findings-disposition.ts";

/**
 * Every member, straight off the const object — exhaustive by construction, so
 * a seventh member joins these loops without anyone remembering to add it.
 */
const EVERY_DISPOSITION = Object.values(AgentComponentFindingsDisposition);

const NO_REASONS = {
  countCapped: false,
  byteGated: false,
  unreadable: false,
} as const;

describe("agentComponentFindingsWithheldDisposition", () => {
  test("nothing withheld is undefined, not a withheld member", () => {
    expect(
      agentComponentFindingsWithheldDisposition(NO_REASONS)
    ).toBeUndefined();
  });

  test("exactly one reason reads as that reason", () => {
    expect(
      agentComponentFindingsWithheldDisposition({
        ...NO_REASONS,
        countCapped: true,
      })
    ).toBe("withheld-count-capped");
    expect(
      agentComponentFindingsWithheldDisposition({
        ...NO_REASONS,
        byteGated: true,
      })
    ).toBe("withheld-byte-gated");
    expect(
      agentComponentFindingsWithheldDisposition({
        ...NO_REASONS,
        unreadable: true,
      })
    ).toBe("withheld-unreadable");
  });

  test("more than one reason reads as ambiguous rather than picking a winner", () => {
    expect(
      agentComponentFindingsWithheldDisposition({
        ...NO_REASONS,
        countCapped: true,
        byteGated: true,
      })
    ).toBe("withheld-ambiguous-reason");
    expect(
      agentComponentFindingsWithheldDisposition({
        countCapped: true,
        byteGated: true,
        unreadable: true,
      })
    ).toBe("withheld-ambiguous-reason");
  });
});

describe("the ingest/read split", () => {
  test("every recorded member is a member, and `unrecorded` is not declarable", () => {
    for (const disposition of EVERY_DISPOSITION) {
      expect(isAgentComponentFindingsDisposition(disposition)).toBe(true);
      expect(agentComponentFindingsDispositionLabel(disposition)).not.toBe("");
    }
    expect(
      isAgentComponentFindingsDisposition(
        AgentComponentFindingsDisposition.Unrecorded
      )
    ).toBe(true);
    expect(
      isAgentComponentFindingsIngestDisposition(
        AgentComponentFindingsDisposition.Unrecorded
      )
    ).toBe(false);
    expect(
      isAgentComponentFindingsIngestDisposition(
        AgentComponentFindingsDisposition.MeasuredThisRun
      )
    ).toBe(true);
  });

  test("a legacy cell and a member this build cannot place both read `unrecorded`", () => {
    expect(readAgentComponentFindingsDisposition(null)).toBe("unrecorded");
    expect(readAgentComponentFindingsDisposition(undefined)).toBe("unrecorded");
    expect(readAgentComponentFindingsDisposition("")).toBe("unrecorded");
    expect(
      readAgentComponentFindingsDisposition("withheld-from-a-newer-build")
    ).toBe("unrecorded");
    expect(readAgentComponentFindingsDisposition("carried-forward")).toBe(
      "carried-forward"
    );
  });

  test("a prototype-polluting key is not a member", () => {
    expect(isAgentComponentFindingsDisposition("__proto__")).toBe(false);
    expect(isAgentComponentFindingsDisposition("constructor")).toBe(false);
  });
});

describe("what each member claims", () => {
  /*
   * Asked through the predicate PRODUCTION reads rather than through per-field
   * accessors nothing calls (@tamsinb review): a member that requires counts
   * and a member that requires their absence are exactly the partition the four
   * deleted `states*` readers described, and this is the surface that actually
   * enforces it at three write boundaries.
   */
  const requiringCounts = EVERY_DISPOSITION.filter(
    (disposition) =>
      isAgentComponentFindingsDispositionConsistentWithFunnel(
        disposition,
        true
      ) &&
      !isAgentComponentFindingsDispositionConsistentWithFunnel(
        disposition,
        false
      )
  );
  const requiringNoCounts = EVERY_DISPOSITION.filter(
    (disposition) =>
      isAgentComponentFindingsDispositionConsistentWithFunnel(
        disposition,
        false
      ) &&
      !isAgentComponentFindingsDispositionConsistentWithFunnel(
        disposition,
        true
      )
  );

  test("the measuring members are exactly the two that require counts", () => {
    expect(requiringCounts).toEqual(["measured-this-run", "carried-forward"]);
  });

  test("the four withheld members are exactly those that require no counts", () => {
    expect(requiringNoCounts).toEqual([
      "withheld-count-capped",
      "withheld-byte-gated",
      "withheld-unreadable",
      "withheld-ambiguous-reason",
    ]);
  });

  test("`unrecorded` claims nothing about the counts either way", () => {
    expect(requiringCounts).not.toContain("unrecorded");
    expect(requiringNoCounts).not.toContain("unrecorded");
  });
});

describe("isAgentComponentFindingsDispositionConsistentWithFunnel", () => {
  test("a withheld member requires no counts and a measuring member requires counts", () => {
    expect(
      isAgentComponentFindingsDispositionConsistentWithFunnel(
        AgentComponentFindingsDisposition.WithheldByteGated,
        false
      )
    ).toBe(true);
    expect(
      isAgentComponentFindingsDispositionConsistentWithFunnel(
        AgentComponentFindingsDisposition.WithheldByteGated,
        true
      )
    ).toBe(false);
    expect(
      isAgentComponentFindingsDispositionConsistentWithFunnel(
        AgentComponentFindingsDisposition.CarriedForward,
        true
      )
    ).toBe(true);
    expect(
      isAgentComponentFindingsDispositionConsistentWithFunnel(
        AgentComponentFindingsDisposition.CarriedForward,
        false
      )
    ).toBe(false);
    expect(
      isAgentComponentFindingsDispositionConsistentWithFunnel(
        AgentComponentFindingsDisposition.MeasuredThisRun,
        false
      )
    ).toBe(false);
  });
});
