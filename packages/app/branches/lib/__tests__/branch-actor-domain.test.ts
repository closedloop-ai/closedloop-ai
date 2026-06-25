import type { MergedTraceItem } from "@repo/api/src/types/branch";
import {
  CHART_COLOR_TOKENS,
  chartColor,
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
  buildActorColorDomain,
  deriveActorsFromSessions,
  deriveActorsFromUsage,
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

  it("gives a single actor exactly one color", () => {
    const domain = buildActorColorDomain(["alice"]);
    expect(domain.ordered).toHaveLength(1);
    expect(domain.colorFor("alice")).toBe(chartColor(0));
  });

  it("cycles colors modulo the palette once actors exceed the palette size", () => {
    const paletteSize = CHART_COLOR_TOKENS.length;
    // One actor past the palette length wraps to the first color. Zero-pad keys
    // so alphabetical ordering (used by buildActorColorDomain) tracks the
    // numeric index, keeping this independent of the palette's exact size.
    const keys = Array.from(
      { length: paletteSize + 1 },
      (_, i) => `actor-${String(i).padStart(2, "0")}`
    );
    const domain = buildActorColorDomain(keys);
    // Index `paletteSize` → chartColor(paletteSize % paletteSize) === chartColor(0).
    expect(domain.colorFor(keys[paletteSize])).toBe(domain.colorFor(keys[0]));
    expect(domain.colorFor(keys[paletteSize])).toBe(chartColor(0));
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
});
