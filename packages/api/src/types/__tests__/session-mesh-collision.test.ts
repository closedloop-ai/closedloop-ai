import { describe, expect, it } from "vitest";
import {
  classifySessionMeshCollision,
  SESSION_MESH_COLLISION_OUTCOME,
  type SessionMeshCollisionEvidence,
  SessionMeshCollisionOutcome,
  sessionMeshAvoidanceRate,
} from "../session-mesh-collision";

function evidence(
  overrides: Partial<SessionMeshCollisionEvidence> = {}
): SessionMeshCollisionEvidence {
  return {
    path: "packages/api/src/types/session-mesh.ts",
    intentBeforeDelivery: false,
    editedDuringClaim: false,
    editedAfterClaim: false,
    ...overrides,
  };
}

describe("classifySessionMeshCollision", () => {
  it("scores a concurrent edit as realized — the product's claim failed", () => {
    expect(
      classifySessionMeshCollision(
        evidence({ intentBeforeDelivery: true, editedDuringClaim: true })
      )
    ).toBe(SessionMeshCollisionOutcome.Realized);
  });

  it("scores intent before and no concurrent edit as avoided", () => {
    expect(
      classifySessionMeshCollision(evidence({ intentBeforeDelivery: true }))
    ).toBe(SessionMeshCollisionOutcome.Avoided);
  });

  it("scores an edit after the claim lapsed as deferred, not avoided", () => {
    expect(
      classifySessionMeshCollision(
        evidence({ intentBeforeDelivery: true, editedAfterClaim: true })
      )
    ).toBe(SessionMeshCollisionOutcome.Deferred);
  });

  it("refuses to credit avoidance without intent before the message", () => {
    // THE load-bearing rule: most recipients were never going to touch the
    // path. Scoring those as avoided would drive the metric to ~100%.
    expect(classifySessionMeshCollision(evidence())).toBe(
      SessionMeshCollisionOutcome.Unknown
    );
  });

  it("scores a concurrent edit as realized even with no prior intent", () => {
    // Realized is checked FIRST on purpose: the collision demonstrably happened,
    // whatever the recipient's prior state looked like.
    expect(
      classifySessionMeshCollision(evidence({ editedDuringClaim: true }))
    ).toBe(SessionMeshCollisionOutcome.Realized);
  });

  it("prefers realized over deferred when both edits are recorded", () => {
    expect(
      classifySessionMeshCollision(
        evidence({
          intentBeforeDelivery: true,
          editedDuringClaim: true,
          editedAfterClaim: true,
        })
      )
    ).toBe(SessionMeshCollisionOutcome.Realized);
  });

  it("covers every declared outcome", () => {
    const produced = new Set([
      classifySessionMeshCollision(evidence({ editedDuringClaim: true })),
      classifySessionMeshCollision(evidence({ intentBeforeDelivery: true })),
      classifySessionMeshCollision(
        evidence({ intentBeforeDelivery: true, editedAfterClaim: true })
      ),
      classifySessionMeshCollision(evidence()),
    ]);
    expect([...produced].sort()).toEqual(
      [...SESSION_MESH_COLLISION_OUTCOME].sort()
    );
  });
});

describe("sessionMeshAvoidanceRate", () => {
  it("rates avoided against avoided plus realized", () => {
    expect(
      sessionMeshAvoidanceRate({
        detected: 100,
        avoided: 3,
        realized: 1,
        deferred: 10,
        unknown: 86,
      })
    ).toBeCloseTo(0.75, 10);
  });

  it("excludes deferred and unknown from BOTH sides of the ratio", () => {
    const withNoise = sessionMeshAvoidanceRate({
      detected: 1000,
      avoided: 3,
      realized: 1,
      deferred: 500,
      unknown: 496,
    });
    const without = sessionMeshAvoidanceRate({
      detected: 4,
      avoided: 3,
      realized: 1,
      deferred: 0,
      unknown: 0,
    });
    // A pile of unknowns must not dilute the rate — that is how a real signal
    // gets buried under deliveries nobody was ever going to act on.
    expect(withNoise).toBe(without);
  });

  it("returns null, never 0, when no collision carried demonstrated intent", () => {
    expect(
      sessionMeshAvoidanceRate({
        detected: 6276,
        avoided: 0,
        realized: 0,
        deferred: 0,
        unknown: 6276,
      })
    ).toBeNull();
  });

  it("reports a true zero when every judged collision was realized", () => {
    // Distinct from the null above: here the product demonstrably did not work.
    expect(
      sessionMeshAvoidanceRate({
        detected: 10,
        avoided: 0,
        realized: 5,
        deferred: 0,
        unknown: 5,
      })
    ).toBe(0);
  });
});
