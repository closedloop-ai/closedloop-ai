import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import {
  CHART_COLOR_PAIR_TOKEN_INDEXES,
  CHART_COLOR_TOKENS,
  chartColorPair,
  chartColorPairForTokenIndex,
} from "@repo/design-system/components/ui/chart-colors";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail,
  makeBranchSession,
  makeBranchUsage,
  makeUsageActorBucket,
  makeUsageHourBucket,
} from "../../__tests__/branch-fixtures";
import {
  ACTOR_SWIMLANE_PALETTE_OFFSET,
  BranchActorTurnSide,
  buildActorColorDomain,
  deriveActorsFromSessions,
  deriveActorsFromUsage,
  derivePrimaryActorFromSessions,
  derivePrimaryUserFromSessions,
  UNATTRIBUTED_ACTOR_KEY,
  UNATTRIBUTED_ACTOR_LABEL,
} from "../branch-actor-domain";

describe("buildActorColorDomain", () => {
  it("orders actors alphabetically with unattributed last", () => {
    const domain = buildActorColorDomain([null, "alice", "bob"]);
    expect(domain.ordered).toEqual(["alice", "bob", UNATTRIBUTED_ACTOR_KEY]);
  });

  it("yields identical colors for the same actor set regardless of order", () => {
    const a = buildActorColorDomain([null, "alice", "bob"]);
    const b = buildActorColorDomain(["bob", "alice", null]);
    expect(a.colorFor("alice")).toBe(b.colorFor("alice"));
    expect(a.colorFor("bob")).toBe(b.colorFor("bob"));
    expect(a.colorFor(null)).toBe(b.colorFor(null));
  });

  it("gives a single actor the primary blue color pair", () => {
    const domain = buildActorColorDomain(["alice"]);
    const pair = chartColorPair(0);
    expect(domain.ordered).toHaveLength(1);
    expect(pair.strong).not.toBe(pair.base);
    expect(domain.colorFor("alice")).toBe(pair.base);
    expect(domain.colorForTurn("alice", BranchActorTurnSide.Human)).toBe(
      pair.soft
    );
    expect(domain.colorForTurn("alice", BranchActorTurnSide.Agent)).toBe(
      pair.strong
    );
  });

  it("promotes an explicit primary actor to the first blue pair", () => {
    const domain = buildActorColorDomain(["alice", "bob"], {
      primaryActor: "bob",
    });
    expect(domain.ordered).toEqual(["bob", "alice"]);
    expect(domain.colorFor("bob")).toBe(chartColorPair(0).base);
    expect(domain.colorFor("alice")).toBe(chartColorPair(1).base);
  });

  it("cycles additional colors without reusing the primary pair", () => {
    const paletteSize = CHART_COLOR_PAIR_TOKEN_INDEXES.length;
    // One actor past the non-primary palette wraps to the first additional
    // color, not to the reserved primary-blue pair.
    const keys = Array.from(
      { length: paletteSize + 1 },
      (_, i) => `actor-${String(i).padStart(2, "0")}`
    );
    const domain = buildActorColorDomain(keys);
    expect(domain.colorFor(keys[0])).toBe(chartColorPair(0).base);
    expect(domain.colorFor(keys[paletteSize])).toBe(domain.colorFor(keys[1]));
    expect(domain.colorFor(keys[paletteSize])).not.toBe(
      domain.colorFor(keys[0])
    );
  });

  it("pins the unattributed sentinel to the LAST palette slot (a stable shared color)", () => {
    const domain = buildActorColorDomain([null, "alice"]);
    expect(domain.colorFor(null)).toBe(
      chartColorPairForTokenIndex(CHART_COLOR_TOKENS.length - 1).base
    );
  });

  it("falls back safely when asked for an owner outside the domain", () => {
    const domain = buildActorColorDomain(["alice"]);
    expect(domain.colorFor("unseen")).toBe(domain.colorFor(null));
    expect(domain.colorForTurn("unseen", BranchActorTurnSide.Agent)).toBe(
      domain.colorForTurn(null, BranchActorTurnSide.Agent)
    );
  });

  describe("paletteOffset (FEA-3576: distinct color bands for E1 vs E4)", () => {
    it("defaults to no offset (attributed colors start at the blue primary pair)", () => {
      const domain = buildActorColorDomain(["alice", "bob"]);
      expect(domain.colorFor("alice")).toBe(chartColorPair(0).base);
      expect(domain.colorFor("bob")).toBe(chartColorPair(1).base);
    });

    it("keeps the primary actor blue while shifting additional actors into a distinct band", () => {
      const actors = buildActorColorDomain(["alice", "bob"], {
        paletteOffset: ACTOR_SWIMLANE_PALETTE_OFFSET,
        primaryActor: "alice",
      });
      expect(actors.colorFor("alice")).toBe(chartColorPair(0).base);
      expect(actors.colorFor("bob")).toBe(
        chartColorPair(ACTOR_SWIMLANE_PALETTE_OFFSET + 1).base
      );
    });

    it("keeps the unattributed color SHARED across offsets (unattributed means the same thing)", () => {
      const users = buildActorColorDomain([null, "alice"]);
      const actors = buildActorColorDomain([null, "alice"], {
        paletteOffset: ACTOR_SWIMLANE_PALETTE_OFFSET,
      });
      expect(actors.colorFor(null)).toBe(users.colorFor(null));
    });

    it("offset does not disturb the attributed indexing of the sibling domain", () => {
      // The offset is applied to additional attributed indexes only;
      // unattributed is not counted and the first real actor stays primary-blue.
      const actors = buildActorColorDomain(["alice", null, "bob"], {
        paletteOffset: ACTOR_SWIMLANE_PALETTE_OFFSET,
      });
      expect(actors.colorFor("alice")).toBe(chartColorPair(0).base);
      expect(actors.colorFor("bob")).toBe(
        chartColorPair(ACTOR_SWIMLANE_PALETTE_OFFSET + 1).base
      );
    });

    it("cycles offset additional actors without reusing the primary pair", () => {
      const actors = buildActorColorDomain(
        ["actor-0", "actor-1", "actor-2", "actor-3", "actor-4", "actor-5"],
        {
          paletteOffset: ACTOR_SWIMLANE_PALETTE_OFFSET,
          primaryActor: "actor-0",
        }
      );
      const primaryColor = actors.colorFor("actor-0");
      for (const actor of ["actor-1", "actor-2", "actor-3", "actor-4"]) {
        expect(actors.colorFor(actor)).not.toBe(primaryColor);
      }
    });
  });

  it("labels and detects the unattributed sentinel", () => {
    const domain = buildActorColorDomain([null, "alice"]);
    expect(domain.labelFor(null)).toBe(UNATTRIBUTED_ACTOR_LABEL);
    expect(domain.labelFor("")).toBe(UNATTRIBUTED_ACTOR_LABEL);
    expect(domain.labelFor("alice")).toBe("alice");
    expect(domain.isUnattributed(null)).toBe(true);
    expect(domain.isUnattributed("")).toBe(true);
    expect(domain.isUnattributed("alice")).toBe(false);
  });
});

describe("deriveActorsFromUsage", () => {
  it("dedupes owners across hour buckets and top-level byActor", () => {
    const usage = makeBranchUsage({
      hourBuckets: [
        makeUsageHourBucket({
          byActor: [
            makeUsageActorBucket({ owner: "alice" }),
            makeUsageActorBucket({ owner: "bob" }),
          ],
        }),
      ],
      byActor: [
        makeUsageActorBucket({ owner: "alice" }),
        makeUsageActorBucket({ owner: null }),
      ],
    });
    const domain = buildActorColorDomain(deriveActorsFromUsage(usage));
    expect(domain.ordered).toEqual(["alice", "bob", UNATTRIBUTED_ACTOR_KEY]);
  });
});

describe("deriveActorsFromSessions", () => {
  it("uses the sessionstart actor name, falling back to harness then unattributed", () => {
    const mergedTrace: MergedTraceItem[] = [
      {
        type: "sessionstart",
        sessionId: "s1",
        t: "2026-06-10T10:00:00.000Z",
        actor: { name: "alice", harness: "claude" },
      },
      {
        type: "sessionstart",
        sessionId: "s2",
        t: "2026-06-10T10:05:00.000Z",
        actor: { name: null, harness: "ci" },
      },
    ];
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({ sessionId: "s1", harness: "claude" }),
        makeBranchSession({ sessionId: "s2", harness: "ci" }),
        makeBranchSession({ sessionId: "s3", harness: "" }),
      ],
      mergedTrace,
    });
    // s1 → captured name 'alice'; s2 → no name, harness 'ci'; s3 → empty harness → null.
    expect(deriveActorsFromSessions(detail)).toEqual(["alice", "ci", null]);
  });

  it("also includes prompt/say actor names for trace turn colors", () => {
    const detail = makeBranchDetail({
      sessions: [makeBranchSession({ sessionId: "s1", harness: "claude" })],
      mergedTrace: [
        {
          type: "sessionstart",
          sessionId: "s1",
          t: "2026-06-10T10:00:00.000Z",
          actor: { name: "alice", harness: "claude" },
        },
        {
          type: "say",
          sessionId: "s1",
          t: "2026-06-10T10:01:00.000Z",
          tMs: 1,
          cumCostUsd: 0.1,
          actorName: "codex",
          text: "hello",
        },
      ],
    });
    expect(deriveActorsFromSessions(detail)).toEqual(["alice", "codex"]);
  });
});

describe("derivePrimaryActorFromSessions", () => {
  it("uses the primary session's resolved actor name", () => {
    const mergedTrace: MergedTraceItem[] = [
      {
        type: "sessionstart",
        sessionId: "s1",
        t: "2026-06-10T10:00:00.000Z",
        actor: { name: "alice", harness: "claude" },
      },
      {
        type: "sessionstart",
        sessionId: "s2",
        t: "2026-06-10T10:05:00.000Z",
        actor: { name: "bob", harness: "claude" },
      },
    ];
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({ sessionId: "s1", isPrimary: false }),
        makeBranchSession({ sessionId: "s2", isPrimary: true }),
      ],
      mergedTrace,
    });
    expect(derivePrimaryActorFromSessions(detail)).toBe("bob");
  });
});

describe("derivePrimaryUserFromSessions", () => {
  it("uses the primary session's resolved human owner", () => {
    const detail = makeBranchDetail({
      sessions: [
        makeBranchSession({
          sessionId: "s1",
          isPrimary: false,
          ownerUserName: "Chris",
        }),
        makeBranchSession({
          sessionId: "s2",
          isPrimary: true,
          ownerUserName: "Thadeus",
        }),
      ],
    });
    expect(derivePrimaryUserFromSessions(detail)).toBe("Thadeus");
  });
});
