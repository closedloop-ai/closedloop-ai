import {
  classifySessionMeshCollision,
  SessionMeshCollisionOutcome,
} from "@repo/api/src/types/session-mesh-collision";
import {
  SessionMeshEvidenceArm,
  sessionMeshAdoptionLift,
  sessionMeshTripsSavedBy,
} from "@repo/api/src/types/session-mesh-evidence";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionMeshEvidenceObserver } from "../src/main/session-mesh/session-mesh-evidence-observer.js";

const AGENT = "claude:abc";
const SUBJECT = "packages/api/src/types/session-mesh.ts";
const PLACEBO = "apps/web/app/layout.tsx";
let clock = 1_000_000;
let observer: SessionMeshEvidenceObserver;

// The hook matcher is `^(?:Edit|Write|MultiEdit|SendMessage)$`
// (session-mesh-hook-installer-core.ts), so a Read NEVER reaches this observer
// in production. Fixtures must build history from a tool the matcher delivers,
// or they assert on a stream that cannot occur.
const DEFAULT_TOOL = "Write";

function tool(
  files: string[],
  options: { name?: string; completed?: boolean; toolUseId?: string } = {}
) {
  observer.observeTool({
    agentKey: AGENT,
    toolName: options.name ?? DEFAULT_TOOL,
    files,
    text: "",
    completed: options.completed ?? true,
    toolUseId: options.toolUseId,
  });
}

function deliver(
  options: { claimExpiresAt?: number | null; intent?: boolean } = {}
) {
  observer.recordDelivery({
    agentKey: AGENT,
    messageId: "msg-1",
    subject: SUBJECT,
    placebo: PLACEBO,
    arm: SessionMeshEvidenceArm.Delivered,
    claimExpiresAt: options.claimExpiresAt ?? null,
    // Supplied by the server from relevance.pathOverlap, never inferred here.
    intentBeforeDelivery: options.intent ?? false,
  });
}

beforeEach(() => {
  clock = 1_000_000;
  observer = new SessionMeshEvidenceObserver({ now: () => clock });
});

describe("intent comes from the server, not the tool stream", () => {
  it("carries the server's relevance verdict through unchanged", () => {
    deliver({ intent: true });

    expect(observer.evidence(AGENT)[0]?.intentBeforeDelivery).toBe(true);
  });

  it("does not infer intent from edits the hook happened to see", () => {
    tool([SUBJECT], { name: "Edit" });
    deliver({ intent: false });

    // The hook matcher cannot see a Read, which is how intent is usually
    // expressed. Inferring it here would under-detect intent and compute the
    // avoidance rate over a biased subset.
    expect(observer.evidence(AGENT)[0]?.intentBeforeDelivery).toBe(false);
  });

  it("does not let post-delivery work manufacture its own intent", () => {
    deliver({ intent: false });
    tool([SUBJECT], { name: "Edit" });

    expect(observer.evidence(AGENT)[0]?.intentBeforeDelivery).toBe(false);
  });
});

describe("subject adoption", () => {
  it("adopts a token that was unreachable before the message", () => {
    deliver();
    tool([SUBJECT]);

    expect(observer.evidence(AGENT)[0]?.subjectAdopted).toBe(true);
  });

  it("does not score continued work on a known file as adoption", () => {
    tool([SUBJECT]);
    deliver();
    tool([SUBJECT]);

    // Seen before AND after is ordinary continued work, not adoption.
    expect(observer.evidence(AGENT)[0]?.subjectAdopted).toBe(false);
  });

  it("runs the placebo test against a path the message never named", () => {
    deliver();
    tool([PLACEBO]);

    const [evidence] = observer.evidence(AGENT);
    expect(evidence?.placeboAdopted).toBe(true);
    expect(evidence?.subjectAdopted).toBe(false);
  });
});

describe("abandonment", () => {
  it("flags an edit announced on the subject that never completed", () => {
    tool([SUBJECT]);
    deliver();
    tool([SUBJECT], { name: "Edit", completed: false });

    expect(observer.evidence(AGENT)[0]?.abandonedInFlight).toBe(true);
  });

  it("clears the flag when the edit does complete", () => {
    tool([SUBJECT]);
    deliver();
    tool([SUBJECT], { name: "Edit", completed: false });
    tool([SUBJECT], { name: "Edit", completed: true });

    expect(observer.evidence(AGENT)[0]?.abandonedInFlight).toBe(false);
  });
});

describe("convergence and claim window", () => {
  it("counts round-trips from delivery to the first edit of the subject", () => {
    deliver();
    tool(["other/a.ts"]);
    tool(["other/b.ts"]);
    tool([SUBJECT], { name: "Edit" });

    expect(observer.evidence(AGENT)[0]?.convergenceTrips).toBe(3);
  });

  it("reports convergence as null when the subject is never edited", () => {
    deliver();
    tool(["other/a.ts"]);

    // Null is "did not converge", not "converged in zero trips".
    expect(observer.evidence(AGENT)[0]?.convergenceTrips).toBeNull();
  });

  it("separates an edit during the claim from one after it lapsed", () => {
    tool([SUBJECT]);
    deliver({ claimExpiresAt: clock + 500, intent: true });
    clock += 5000;
    tool([SUBJECT], { name: "Edit" });

    const [evidence] = observer.evidence(AGENT);
    expect(evidence?.editedDuringClaim).toBe(false);
    expect(evidence?.editedAfterClaim).toBe(true);
    expect(classifySessionMeshCollision({ path: SUBJECT, ...evidence! })).toBe(
      SessionMeshCollisionOutcome.Deferred
    );
  });

  it("feeds an avoided collision when intent existed and no edit followed", () => {
    tool([SUBJECT]);
    deliver({ claimExpiresAt: clock + 10_000, intent: true });
    tool(["somewhere/else.ts"], { name: "Edit" });

    const [evidence] = observer.evidence(AGENT);
    expect(classifySessionMeshCollision({ path: SUBJECT, ...evidence! })).toBe(
      SessionMeshCollisionOutcome.Avoided
    );
  });

  it("feeds a realized collision when the subject is edited during the claim", () => {
    tool([SUBJECT]);
    deliver({ claimExpiresAt: clock + 10_000, intent: true });
    tool([SUBJECT], { name: "Edit" });

    const [evidence] = observer.evidence(AGENT);
    expect(classifySessionMeshCollision({ path: SUBJECT, ...evidence! })).toBe(
      SessionMeshCollisionOutcome.Realized
    );
  });
});

describe("controls and pricing", () => {
  it("carries the withheld arm so the no-treatment baseline is separable", () => {
    observer.recordDelivery({
      agentKey: AGENT,
      messageId: "msg-withheld",
      subject: SUBJECT,
      arm: SessionMeshEvidenceArm.Withheld,
      intentBeforeDelivery: false,
    });

    expect(observer.evidence(AGENT)[0]?.arm).toBe(
      SessionMeshEvidenceArm.Withheld
    );
  });

  it("prices trips saved against a caller-supplied baseline", () => {
    expect(sessionMeshTripsSavedBy({ convergenceTrips: 2 }, 7)).toBe(5);
  });

  it("clamps a slower-than-baseline convergence at zero, never negative", () => {
    // A negative would subtract real savings from other deliveries in a sum.
    expect(sessionMeshTripsSavedBy({ convergenceTrips: 20 }, 7)).toBe(0);
  });

  it("prices nothing when convergence or the baseline is unknown", () => {
    expect(sessionMeshTripsSavedBy({ convergenceTrips: null }, 7)).toBeNull();
    expect(sessionMeshTripsSavedBy({ convergenceTrips: 2 }, null)).toBeNull();
  });

  it("reports adoption lift over the placebo, and null when nothing was seen", () => {
    expect(
      sessionMeshAdoptionLift({
        observed: 100,
        subjectAdopted: 40,
        abandonedInFlight: 5,
        converged: 30,
        placeboAdopted: 10,
      })
    ).toBeCloseTo(0.3, 10);
    expect(
      sessionMeshAdoptionLift({
        observed: 0,
        subjectAdopted: 0,
        abandonedInFlight: 0,
        converged: 0,
        placeboAdopted: 0,
      })
    ).toBeNull();
  });

  it("reports zero lift when named and unnamed subjects are adopted alike", () => {
    // At or below zero the proxy is measuring churn and must not be read as
    // evidence of usefulness.
    expect(
      sessionMeshAdoptionLift({
        observed: 50,
        subjectAdopted: 20,
        abandonedInFlight: 0,
        converged: 0,
        placeboAdopted: 20,
      })
    ).toBe(0);
  });
});

describe("one tool call is one turn", () => {
  it("does not let a pre/post hook pair double the convergence count", () => {
    deliver();
    tool([SUBJECT], { name: "Edit", completed: false, toolUseId: "tu-1" });
    tool([SUBJECT], { name: "Edit", completed: true, toolUseId: "tu-1" });

    // One Edit is one round-trip. The hook fires twice for it; counting events
    // priced every delivery at twice the trips it actually took.
    expect(observer.evidence(AGENT)[0]?.convergenceTrips).toBe(1);
  });

  it("still counts distinct tool calls separately", () => {
    deliver();
    tool(["other/a.ts"], { toolUseId: "tu-1" });
    tool([SUBJECT], { name: "Edit", toolUseId: "tu-2" });

    expect(observer.evidence(AGENT)[0]?.convergenceTrips).toBe(2);
  });
});

describe("a saturated history cannot claim adoption", () => {
  function saturate() {
    for (let index = 0; index < 400; index += 1) {
      tool([`filler/${index}.ts`], { toolUseId: `fill-${index}` });
    }
  }

  it("reports adoption as null, not true, once prior use is unknowable", () => {
    saturate();
    // Past the cap: this edit is NOT recorded in history, so at delivery the
    // subject reads as unseen even though the session just worked on it.
    tool([SUBJECT], { toolUseId: "pre" });
    tool([PLACEBO], { toolUseId: "pre-placebo" });
    deliver();
    tool([SUBJECT], { toolUseId: "post" });
    tool([PLACEBO], { toolUseId: "post-placebo" });

    const [evidence] = observer.evidence(AGENT);
    expect(evidence?.subjectAdopted).toBeNull();
    expect(evidence?.placeboAdopted).toBeNull();
  });

  it("keeps the decidable half decided when the token was never seen after", () => {
    saturate();
    deliver();

    // Never referenced after the message: not adoption, whatever the history.
    expect(observer.evidence(AGENT)[0]?.subjectAdopted).toBe(false);
  });

  it("reports a real boolean while the history is still complete", () => {
    deliver();
    tool([SUBJECT]);

    expect(observer.evidence(AGENT)[0]?.subjectAdopted).toBe(true);
  });
});

describe("completion the hook stream cannot report", () => {
  /** Desktop installs `PreToolUse` only, so production announces an edit and
   * never reports its outcome. */
  function announceEdit() {
    observer.observeTool({
      agentKey: AGENT,
      toolName: "Edit",
      files: [SUBJECT],
      text: "",
    });
  }

  it("reports abandonment as null, not false, for an edit with no outcome", () => {
    tool([SUBJECT]);
    deliver();
    announceEdit();

    const [evidence] = observer.evidence(AGENT);
    // A `false` would claim a measured absence of abandonment on every delivery
    // in production; a `true` would claim every announced edit was abandoned.
    expect(evidence?.abandonedInFlight).toBeNull();
    // The edit still counts for the proxies that do not need the outcome.
    expect(evidence?.convergenceTrips).toBe(1);
    expect(evidence?.editedDuringClaim).toBe(true);
  });

  it("keeps abandonment decided when no edit was announced at all", () => {
    deliver();
    tool(["other/a.ts"]);

    expect(observer.evidence(AGENT)[0]?.abandonedInFlight).toBe(false);
  });

  it("decides it again once a completion is actually observed", () => {
    deliver();
    announceEdit();
    tool([SUBJECT], { name: "Edit", completed: true });

    expect(observer.evidence(AGENT)[0]?.abandonedInFlight).toBe(false);
  });
});
