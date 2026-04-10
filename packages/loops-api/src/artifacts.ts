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
  Features: "features.json",
  ImplementationPlanMarkdown: "implementation-plan.md",
  OpenQuestions: "open-questions.md",
  Perf: "perf.jsonl",
  State: "state.json",
} as const;
export type LoopArtifactFile =
  (typeof LoopArtifactFile)[keyof typeof LoopArtifactFile];
