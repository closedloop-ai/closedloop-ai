/**
 * ISS-12017: the vibe seed's GitHub stages sit where their inputs exist and
 * their outputs are needed, and the session-links re-delivery hands the fold
 * only the sessions it has refs for.
 */

import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { deliverWithRefs } from "../vibe-seed/github/session-links";
import type { GoldenSessionRefs } from "../vibe-seed/github/store-refs";
import { VIBE_SEED_STAGES } from "../vibe-seed/stages";

const REFS: GoldenSessionRefs = {
  artifactRefs: [
    {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/x",
      method: "git_push",
      relation: ArtifactRefRelation.Created,
    },
  ],
  prRefs: [],
};

describe("GitHub stage order", () => {
  it("links sessions, replays branch evidence, then lets the derived rollup read the links", () => {
    const names = VIBE_SEED_STAGES.map((stage) => stage.name);
    const position = (name: string) => {
      const index = names.indexOf(name);
      expect(index, name).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(position("github-session-links")).toBeLessThan(
      position("github-branch-evidence")
    );
    expect(position("github-branch-evidence")).toBeLessThan(
      position("branch-analytics-rollup")
    );
    expect(position("team-repositories")).toBeGreaterThan(
      position("github-session-links")
    );
  });
});

describe("deliverWithRefs", () => {
  it("keeps only sessions with refs, attaches them, and recounts the batch", async () => {
    const deliver = vi.fn(() =>
      Promise.resolve({ accepted: true as const, acceptedSessionIds: ["a"] })
    );
    const ack = await deliverWithRefs(
      {
        batchId: "batch-1",
        sessionCount: 2,
        sessions: [
          { externalSessionId: "a", events: [] },
          { externalSessionId: "b", events: [] },
        ],
      },
      new Map([["a", REFS]]),
      deliver
    );
    expect(ack).toStrictEqual({ accepted: true, acceptedSessionIds: ["a"] });
    expect(deliver).toHaveBeenCalledWith({
      batchId: "batch-1",
      sessionCount: 1,
      sessions: [
        {
          externalSessionId: "a",
          events: [],
          artifactRefs: REFS.artifactRefs,
          prRefs: REFS.prRefs,
        },
      ],
    });
  });

  it("acknowledges a batch with no linked session without calling the fold", async () => {
    const deliver = vi.fn();
    await expect(
      deliverWithRefs(
        { sessionCount: 1, sessions: [{ externalSessionId: "b" }] },
        new Map([["a", REFS]]),
        deliver
      )
    ).resolves.toStrictEqual({ accepted: true, acceptedSessionIds: [] });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses a batch that carries no sessions array", () => {
    expect(() => deliverWithRefs({}, new Map(), vi.fn())).toThrow(
      "without sessions"
    );
  });
});
