/**
 * Artifact type strings and file name constants for loop-produced artifacts.
 */

// Subset of ArtifactType relevant to loop context packs and artifact ingestion
export const LoopArtifactType = {
  Prd: "PRD",
  ImplementationPlan: "IMPLEMENTATION_PLAN",
  Feature: "FEATURE",
} as const;
export type LoopArtifactType =
  (typeof LoopArtifactType)[keyof typeof LoopArtifactType];

// Canonical file names for loop-produced artifacts
export const LoopArtifactFile = {
  Plan: "plan.json",
  PlanMarkdown: "plan.md",
  Prd: "prd.md",
  ExecutionResult: "execution-result.json",
  Judges: "judges.json",
  PrdJudges: "prd-judges.json",
  PlanJudges: "plan-judges.json",
  CodeJudges: "code-judges.json",
} as const;
export type LoopArtifactFile =
  (typeof LoopArtifactFile)[keyof typeof LoopArtifactFile];

/**
 * Normalize lowercase artifact type variants (Electron legacy) to canonical uppercase.
 * Returns the input unchanged if already uppercase or unrecognized.
 */
const LOWERCASE_ARTIFACT_TYPE_MAP: Record<string, LoopArtifactType> = {
  prd: LoopArtifactType.Prd,
  plan: LoopArtifactType.ImplementationPlan,
  artifact: LoopArtifactType.Feature,
};

export function normalizeArtifactType(type: string): string {
  return LOWERCASE_ARTIFACT_TYPE_MAP[type] ?? type;
}
