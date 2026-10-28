import {
  AgentComponentFindingsFunnelState,
  readAgentComponentFindingsFunnel,
} from "@repo/api/src/types/agent-component-findings-funnel";
import { AgentComponentFindingsProvenance } from "@repo/api/src/types/agent-component-findings-provenance";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import realReviewResult from "./__fixtures__/review-result-run.json";
import {
  attributeCodeReviewFindings,
  CodeReviewComponentAssociation,
  CodeReviewReviewerAttribution,
  classifyCodeReviewReviewer,
} from "./findings-funnel-attribution.ts";
import { parseCodeReviewResultEnvelope } from "./review-result-envelope.ts";

const CONFIRMED = "CONFIRMED";
const REJECTED = "REJECTED";

function attributeRaw(value: unknown) {
  const parsed = parseCodeReviewResultEnvelope(value);
  if (!parsed.ok) {
    throw new Error(`fixture did not parse: ${parsed.rejection}`);
  }
  return attributeCodeReviewFindings(parsed.envelope);
}

describe("attributeCodeReviewFindings — against a real envelope", () => {
  // A verbatim `review_result.json` the plugin wrote for a real review run.
  const attribution = attributeRaw(realReviewResult);

  it("joins each reviewer to the subagent it is spawned as", () => {
    expect(
      attribution.matched.map((entry) => [
        entry.reviewerId,
        entry.componentKey,
        entry.funnel?.findingsEmitted ?? null,
      ])
    ).toEqual([
      ["auditor", "code-review:code-review-worker", null],
      ["bha_p0", "code-review:code-review-worker", 1],
      ["bhb", "code-review:code-review-worker-graph", 1],
    ]);
    expect(
      attribution.matched.every(
        (entry) => entry.componentKind === AgentComponentInvocationKind.Subagent
      )
    ).toBe(true);
  });

  it("keeps two producers that share one component key apart", () => {
    const workerEntries = attribution.matched.filter(
      (entry) => entry.componentKey === "code-review:code-review-worker"
    );
    expect(workerEntries.map((entry) => entry.reviewerId)).toEqual([
      "auditor",
      "bha_p0",
    ]);
  });

  it("refuses to call a shared or release-spanning key an exact invocation", () => {
    expect(
      attribution.matched.map((entry) => [
        entry.reviewerId,
        entry.association,
        entry.componentKeys.length,
      ])
    ).toEqual([
      ["auditor", CodeReviewComponentAssociation.Ambiguous, 1],
      ["bha_p0", CodeReviewComponentAssociation.Ambiguous, 1],
      ["bhb", CodeReviewComponentAssociation.Ambiguous, 2],
    ]);
  });

  it("reports the two findings that never reached a verdict", () => {
    // auditor_f0 and bhb_f0 sit in `verified[]` with `verifier_verdict: null`.
    expect(attribution.unadjudicatedFindings).toBe(2);
    expect(attribution.fullyAdjudicated).toBe(false);
    expect(attribution.unattributedFindings).toBe(0);
  });

  it("reads a producer with no adjudicated finding as unknown, not zero", () => {
    const auditor = attribution.matched.find(
      (entry) => entry.reviewerId === "auditor"
    );
    expect(auditor?.funnel).toBeNull();
    expect(auditor?.unadjudicatedFindings).toBe(1);
    expect(readAgentComponentFindingsFunnel(auditor?.funnel)).toEqual({
      state: AgentComponentFindingsFunnelState.Unknown,
    });
  });
});

describe("attributeCodeReviewFindings — bucket to count mapping", () => {
  it("counts rejected as invalidated and leaves the unadjudicated out of both", () => {
    const attribution = attributeRaw({
      verified: [
        { reviewer: "bhb", verifier_verdict: CONFIRMED },
        { reviewer: "bhb", verifier_verdict: CONFIRMED },
      ],
      justified: [{ reviewer: "bhb", verifier_verdict: "JUSTIFIED-VALID" }],
      rejected: [
        { reviewer: "bhb", verifier_verdict: REJECTED },
        { reviewer: "bhb", verifier_verdict: REJECTED },
      ],
      pending_verification: [{ reviewer: "bhb" }, { reviewer: "bhb" }],
    });
    const [entry] = attribution.matched;
    expect(entry.funnel).toEqual({
      findingsEmitted: 5,
      findingsInvalidated: 2,
      // ISS-10739: this join reads the plugin's own envelope, so the funnel it
      // produces states that route rather than leaving a reader to guess.
      findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
    });
    expect(entry.unadjudicatedFindings).toBe(2);
    expect(readAgentComponentFindingsFunnel(entry.funnel)).toMatchObject({
      state: AgentComponentFindingsFunnelState.Measured,
      findingsConfirmed: 3,
    });
  });

  it("does not read bucket membership as a verdict", () => {
    // The finalizer lands tier-skipped and unkeyed findings in `verified[]`
    // with `verifier_verdict` null. Counting them would claim a verdict
    // nobody reached — the precise thing excluding pending exists to stop.
    const attribution = attributeRaw({
      verified: [
        { reviewer: "bhb", verifier_verdict: CONFIRMED },
        { reviewer: "bhb", verifier_verdict: null },
        { reviewer: "bhb" },
      ],
    });
    const [entry] = attribution.matched;
    expect(entry.funnel).toEqual({
      findingsEmitted: 1,
      findingsInvalidated: 0,
      // ISS-10739: this join reads the plugin's own envelope, so the funnel it
      // produces states that route rather than leaving a reader to guess.
      findingsProvenance: AgentComponentFindingsProvenance.PluginEmitted,
    });
    expect(entry.unadjudicatedFindings).toBe(2);
    expect(attribution.fullyAdjudicated).toBe(false);
  });

  it("marks a run that still has a pending finding as not fully adjudicated", () => {
    expect(
      attributeRaw({
        verified: [{ reviewer: "bhb", verifier_verdict: CONFIRMED }],
        pending_verification: [{ reviewer: "auditor" }],
      })
    ).toMatchObject({
      fullyAdjudicated: false,
      unadjudicatedFindings: 1,
    });
  });
});

describe("the reviewer join counts its own failures", () => {
  it("counts an unknown producer instead of reading it as a zero", () => {
    const attribution = attributeRaw({
      verified: [
        { reviewer: "bhb", verifier_verdict: CONFIRMED },
        {
          reviewer: "reviewer-we-have-never-seen",
          verifier_verdict: CONFIRMED,
        },
        {
          reviewer: "reviewer-we-have-never-seen",
          verifier_verdict: CONFIRMED,
        },
        { reviewer: "hygiene", verifier_verdict: CONFIRMED },
      ],
      rejected: [{}, { reviewer: null }, { reviewer: 7 }, "not an object"],
    });
    expect(attribution.matched.map((entry) => entry.reviewerId)).toEqual([
      "bhb",
    ]);
    expect(
      attribution.unmatched.map((entry) => [
        entry.reviewerId,
        entry.funnel?.findingsEmitted ?? null,
      ])
    ).toEqual([["reviewer-we-have-never-seen", 2]]);
    expect(attribution.deterministic.map((entry) => entry.reviewerId)).toEqual([
      "hygiene",
    ]);
    expect(attribution.unattributedFindings).toBe(4);
  });

  it("classifies the partitioned and numbered reviewer ids", () => {
    expect(classifyCodeReviewReviewer("bha_p3")).toEqual({
      attribution: CodeReviewReviewerAttribution.Matched,
      componentKeys: ["code-review:code-review-worker"],
    });
    expect(classifyCodeReviewReviewer("domain_2")).toEqual({
      attribution: CodeReviewReviewerAttribution.Matched,
      componentKeys: ["code-review:code-review-worker"],
    });
    expect(classifyCodeReviewReviewer("bha_partition")).toEqual({
      attribution: CodeReviewReviewerAttribution.Unmatched,
      componentKeys: [],
    });
    expect(classifyCodeReviewReviewer("coverage-verifier")).toEqual({
      attribution: CodeReviewReviewerAttribution.Deterministic,
      componentKeys: [],
    });
  });

  it("accepts the SCHEMA.md role names an agent writes for itself", () => {
    // `_coerce_reviewer_id` keeps whatever the agent wrote; only the filename
    // fallback produces `bhb` / `auditor` / `bha_p0`.
    for (const [reviewerId, componentKeys] of [
      ["bug_hunter_a", ["code-review:code-review-worker"]],
      ["unified_auditor", ["code-review:code-review-worker"]],
      ["test_quality", ["code-review:code-review-worker"]],
      [
        "bug_hunter_b",
        [
          "code-review:code-review-worker-graph",
          "code-review:code-review-worker",
        ],
      ],
      [
        "fast_path_reviewer",
        [
          "code-review:code-review-worker-graph",
          "code-review:code-review-worker",
        ],
      ],
    ] as const) {
      expect(classifyCodeReviewReviewer(reviewerId)).toEqual({
        attribution: CodeReviewReviewerAttribution.Matched,
        componentKeys,
      });
    }
  });

  it("classifies the remaining in-process helpers rather than counting them", () => {
    for (const reviewerId of [
      "signal-extractor",
      "coverage-critic",
      "foundation",
    ]) {
      expect(classifyCodeReviewReviewer(reviewerId)).toMatchObject({
        attribution: CodeReviewReviewerAttribution.Deterministic,
      });
    }
    expect(
      attributeRaw({
        verified: [{ reviewer: "foundation", verifier_verdict: CONFIRMED }],
      }).unmatched
    ).toEqual([]);
  });

  it("calls a sole occupant of a single-candidate key an exact association", () => {
    const [entry] = attributeRaw({
      verified: [{ reviewer: "bha_p0", verifier_verdict: CONFIRMED }],
    }).matched;
    expect(entry.association).toBe(CodeReviewComponentAssociation.Exact);
    expect(entry.componentKeys).toEqual(["code-review:code-review-worker"]);
  });

  it("keeps a graph role that an older run spawned as the default worker", () => {
    const [entry] = attributeRaw({
      verified: [{ reviewer: "bhb", verifier_verdict: CONFIRMED }],
    }).matched;
    expect(entry.componentKeys).toContain("code-review:code-review-worker");
    expect(entry.association).toBe(CodeReviewComponentAssociation.Ambiguous);
  });

  it("does not match a reviewer id that names an Object prototype member", () => {
    for (const reviewerId of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(classifyCodeReviewReviewer(reviewerId)).toEqual({
        attribution: CodeReviewReviewerAttribution.Unmatched,
        componentKeys: [],
      });
    }
  });
});
