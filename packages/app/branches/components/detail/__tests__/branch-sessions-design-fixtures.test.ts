import { describe, expect, it } from "vitest";
import {
  designSessionsDetail,
  designSessionsTrace,
} from "../branch-sessions-design-fixtures";

describe("designSessionsTrace (ISS-12576)", () => {
  it("draws every element the merged trace carries", () => {
    const types = new Set(designSessionsTrace.items.map((item) => item.type));
    expect([...types].sort()).toEqual(
      [
        "end",
        "event",
        "idle",
        "prompt",
        "say",
        "sessionstart",
        "subagent",
        "tools",
      ].sort()
    );
    const dots = new Set(
      designSessionsTrace.items.flatMap((item) =>
        item.type === "event" ? [item.dot] : []
      )
    );
    expect([...dots].sort()).toEqual(["b", "g", "r"]);
    expect(
      designSessionsTrace.items.some(
        (item) => item.type === "tools" && item.hasFail
      )
    ).toBe(true);
    const starts = designSessionsTrace.items.flatMap((item) =>
      item.type === "sessionstart" ? [item.actor] : []
    );
    expect(starts.some((actor) => actor.isNew)).toBe(true);
    expect(starts.some((actor) => actor.isResumed)).toBe(true);
    expect(starts.some((actor) => actor.ci)).toBe(true);
  });

  it("agrees with the branch's sessions on ids and cost", () => {
    const ids = designSessionsDetail.sessions.map((s) => s.sessionId);
    expect(
      designSessionsTrace.sessions.map((s) => s.identity.artifactId)
    ).toEqual(ids);
    for (const id of ids) {
      const items = designSessionsTrace.items.filter(
        (item) => item.sessionId === id
      );
      expect(items[0]?.type).toBe("sessionstart");
      expect(items.at(-1)?.type).toBe("end");
    }
    const total = designSessionsDetail.sessions.reduce(
      (sum, s) => sum + (s.estimatedCostUsd ?? 0),
      0
    );
    expect(designSessionsDetail.estimatedCostUsd).toBeCloseTo(total);
  });
});
