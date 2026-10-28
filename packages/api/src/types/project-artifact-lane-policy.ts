import { z } from "zod";
import { MOVE_ARTIFACT_CONFLICT } from "./project-artifact-move.ts";
import { ProjectArtifactPlacementGroupField } from "./project-artifact-placement.ts";

export const PROJECT_ARTIFACT_LANE_POLICY_VERSION = 1 as const;

export const ProjectArtifactLanePolicyReason = {
  PolicyChanged: "policy_changed",
  UnsupportedTransition: "unsupported_transition",
  WipLimitReached: "wip_limit_reached",
} as const;
export type ProjectArtifactLanePolicyReason =
  (typeof ProjectArtifactLanePolicyReason)[keyof typeof ProjectArtifactLanePolicyReason];

/** Human-authored ticket vocabulary; unknown future reasons use existing conflict copy. */
export const PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS = {
  [ProjectArtifactLanePolicyReason.PolicyChanged]: MOVE_ARTIFACT_CONFLICT,
  [ProjectArtifactLanePolicyReason.UnsupportedTransition]:
    "Unsupported transition",
  [ProjectArtifactLanePolicyReason.WipLimitReached]: "WIP limit",
} as const satisfies Record<ProjectArtifactLanePolicyReason, string>;

export type ProjectArtifactLanePolicy = {
  field: ProjectArtifactPlacementGroupField;
  revision: string;
  transitions?: Record<string, string[]>;
  version: typeof PROJECT_ARTIFACT_LANE_POLICY_VERSION;
  wipLimitByLane?: Record<string, number>;
};

export type ProjectArtifactLanePolicyMove = {
  destinationLaneId: string;
  rootId: string;
  sourceLaneId: string;
};

export type ProjectArtifactLanePolicyResult =
  | { allowed: true }
  | { allowed: false; reason: ProjectArtifactLanePolicyReason };

const laneMapSchema = z.record(
  z.string().min(1).max(128),
  z.array(z.string().min(1).max(128)).max(128)
);

export const projectArtifactLanePolicySchema = z
  .object({
    field: z.enum(ProjectArtifactPlacementGroupField),
    revision: z.string().min(1).max(128),
    transitions: laneMapSchema.optional(),
    version: z.literal(PROJECT_ARTIFACT_LANE_POLICY_VERSION),
    wipLimitByLane: z
      .record(z.string().min(1).max(128), z.number().int().min(1).max(5000))
      .optional(),
  })
  .strict();

/** Unknown/newer optional policy payloads safely mean no policy for this build. */
export function parseProjectArtifactLanePolicy(
  input: unknown
): ProjectArtifactLanePolicy | null {
  const parsed = projectArtifactLanePolicySchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** One transition/capacity result shared by UI, optimistic admission, API, and Undo. */
export function evaluateProjectArtifactLanePolicy(input: {
  expectedPolicyRevision?: string;
  laneRootIds: Readonly<Record<string, readonly string[]>>;
  moves: readonly ProjectArtifactLanePolicyMove[];
  policy: ProjectArtifactLanePolicy | null | undefined;
}): ProjectArtifactLanePolicyResult {
  const { policy } = input;
  if (!policy) {
    return { allowed: true };
  }
  if (
    input.expectedPolicyRevision !== undefined &&
    input.expectedPolicyRevision !== policy.revision
  ) {
    return {
      allowed: false,
      reason: ProjectArtifactLanePolicyReason.PolicyChanged,
    };
  }
  for (const move of input.moves) {
    if (move.sourceLaneId === move.destinationLaneId) {
      continue;
    }
    const allowedTargets = policy.transitions?.[move.sourceLaneId];
    if (allowedTargets && !allowedTargets.includes(move.destinationLaneId)) {
      return {
        allowed: false,
        reason: ProjectArtifactLanePolicyReason.UnsupportedTransition,
      };
    }
  }
  const movesByDestination = new Map<string, ProjectArtifactLanePolicyMove[]>();
  for (const move of input.moves) {
    const current = movesByDestination.get(move.destinationLaneId);
    if (current) {
      current.push(move);
    } else {
      movesByDestination.set(move.destinationLaneId, [move]);
    }
  }
  for (const [laneId, moves] of movesByDestination) {
    const limit = policy.wipLimitByLane?.[laneId];
    if (limit === undefined) {
      continue;
    }
    const currentRoots = new Set(input.laneRootIds[laneId] ?? []);
    const incoming = moves.filter(
      (move) => !currentRoots.has(move.rootId)
    ).length;
    if (currentRoots.size + incoming > limit) {
      return {
        allowed: false,
        reason: ProjectArtifactLanePolicyReason.WipLimitReached,
      };
    }
  }
  return { allowed: true };
}

/** Accessible fallback for unknown future refusal reasons. */
export function projectArtifactLanePolicyReasonLabel(reason: unknown): string {
  return typeof reason === "string" &&
    reason in PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS
    ? PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS[
        reason as ProjectArtifactLanePolicyReason
      ]
    : MOVE_ARTIFACT_CONFLICT;
}
