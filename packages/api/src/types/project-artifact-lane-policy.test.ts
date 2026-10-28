import { describe, expect, it } from "vitest";
import {
  evaluateProjectArtifactLanePolicy,
  PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS,
  PROJECT_ARTIFACT_LANE_POLICY_VERSION,
  type ProjectArtifactLanePolicy,
  ProjectArtifactLanePolicyReason,
  parseProjectArtifactLanePolicy,
  projectArtifactLanePolicyReasonLabel,
} from "./project-artifact-lane-policy";
import { MOVE_ARTIFACT_CONFLICT } from "./project-artifact-move";
import { ProjectArtifactPlacementGroupField } from "./project-artifact-placement";

const POLICY: ProjectArtifactLanePolicy = {
  field: ProjectArtifactPlacementGroupField.Status,
  revision: "policy-v1",
  transitions: { todo: ["doing"], doing: ["done"] },
  version: PROJECT_ARTIFACT_LANE_POLICY_VERSION,
  wipLimitByLane: { doing: 3 },
};

describe("CT-18 AC-002/AC-009 Project Artifact lane policy", () => {
  it("has no transition restriction or default cap when policy is absent", () => {
    expect(
      evaluateProjectArtifactLanePolicy({
        laneRootIds: { doing: ["a", "b", "c"] },
        moves: [move("new", "todo", "doing")],
        policy: null,
      })
    ).toEqual({ allowed: true });
  });

  it("allows configured transitions and refuses unsupported ones", () => {
    expect(
      evaluateProjectArtifactLanePolicy({
        laneRootIds: { doing: [] },
        moves: [move("a", "todo", "doing")],
        policy: POLICY,
      })
    ).toEqual({ allowed: true });
    expect(
      evaluateProjectArtifactLanePolicy({
        laneRootIds: { done: [] },
        moves: [move("a", "todo", "done")],
        policy: POLICY,
      })
    ).toEqual({
      allowed: false,
      reason: ProjectArtifactLanePolicyReason.UnsupportedTransition,
    });
  });

  it("allows an at-cap in-lane move and refuses incoming selected roots", () => {
    expect(
      evaluateProjectArtifactLanePolicy({
        laneRootIds: { doing: ["a", "b", "c"] },
        moves: [move("a", "doing", "doing")],
        policy: POLICY,
      })
    ).toEqual({ allowed: true });
    expect(
      evaluateProjectArtifactLanePolicy({
        laneRootIds: { doing: ["a"] },
        moves: [
          move("b", "todo", "doing"),
          move("c", "todo", "doing"),
          move("d", "todo", "doing"),
        ],
        policy: POLICY,
      })
    ).toEqual({
      allowed: false,
      reason: ProjectArtifactLanePolicyReason.WipLimitReached,
    });
  });

  it("refuses a stale policy revision before evaluating the move", () => {
    expect(
      evaluateProjectArtifactLanePolicy({
        expectedPolicyRevision: "policy-v0",
        laneRootIds: { doing: [] },
        moves: [move("a", "todo", "doing")],
        policy: POLICY,
      })
    ).toEqual({
      allowed: false,
      reason: ProjectArtifactLanePolicyReason.PolicyChanged,
    });
  });

  it("drops malformed/newer optional policies and labels unknown reasons safely", () => {
    expect(
      parseProjectArtifactLanePolicy({ ...POLICY, version: 2 })
    ).toBeNull();
    expect(
      parseProjectArtifactLanePolicy({
        ...POLICY,
        wipLimitByLane: { doing: 0 },
      })
    ).toBeNull();
    expect(projectArtifactLanePolicyReasonLabel("future_reason")).toBe(
      MOVE_ARTIFACT_CONFLICT
    );
    expect(
      PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS[
        ProjectArtifactLanePolicyReason.UnsupportedTransition
      ]
    ).toBe("Unsupported transition");
  });
});

function move(rootId: string, sourceLaneId: string, destinationLaneId: string) {
  return { destinationLaneId, rootId, sourceLaneId };
}
