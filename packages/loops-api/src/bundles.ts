import { LoopArtifactFile } from "./artifacts";
import { LoopCommand } from "./commands";

/**
 * Context pack file bundle — files written to disk from the context pack
 * before the loop agent starts. Written to .claude/context/ (ECS) or
 * .closedloop-ai/context/ (Electron).
 */
export const ContextPackFileBundle = {
  /** Prompt file written from pack.prompt */
  Prompt: "prompt.md",
  /** Repo metadata written from pack.repoInfo */
  RepoInfo: "repo-info.json",
  /** Prior loop summaries written from pack.priorLoopSummaries */
  PriorLoops: "prior-loops.md",
  /** Artifact files written as {type}-{id}.md from pack.artifacts[] */
  ArtifactPattern: "{type}-{id}.md",
  /** Attachments directory */
  AttachmentsDir: "attachments",
} as const;

/**
 * Result bundle manifest — defines which artifact files each command produces.
 * Used to validate that a loop produced the expected outputs before ingestion.
 *
 * `required`: files that must exist for successful ingestion
 * `optional`: files that may exist and will be ingested if present
 */
export type ResultBundleManifest = {
  required: readonly string[];
  optional: readonly string[];
};

export const ResultBundle: Record<LoopCommand, ResultBundleManifest> = {
  [LoopCommand.Plan]: {
    required: [LoopArtifactFile.Plan],
    optional: [
      LoopArtifactFile.PlanMarkdown,
      LoopArtifactFile.OpenQuestions,
      LoopArtifactFile.Judges,
      LoopArtifactFile.ImplementationPlanMarkdown,
    ],
  },
  [LoopCommand.Execute]: {
    required: [LoopArtifactFile.ExecutionResult],
    optional: [LoopArtifactFile.CodeJudges],
  },
  [LoopCommand.RequestChanges]: {
    required: [LoopArtifactFile.Plan],
    optional: [
      LoopArtifactFile.PlanMarkdown,
      LoopArtifactFile.OpenQuestions,
      LoopArtifactFile.Judges,
    ],
  },
  [LoopCommand.RequestPrdChanges]: {
    required: [LoopArtifactFile.Prd],
    optional: [],
  },
  [LoopCommand.Decompose]: {
    required: [LoopArtifactFile.Features],
    optional: [],
  },
  [LoopCommand.GeneratePrd]: {
    required: [LoopArtifactFile.Prd],
    optional: [],
  },
  [LoopCommand.EvaluatePrd]: {
    required: [LoopArtifactFile.PrdJudges],
    optional: [],
  },
  [LoopCommand.EvaluatePlan]: {
    required: [LoopArtifactFile.PlanJudges],
    optional: [],
  },
  [LoopCommand.EvaluateCode]: {
    required: [LoopArtifactFile.CodeJudges],
    optional: [],
  },
  [LoopCommand.Chat]: {
    required: [],
    optional: [],
  },
  [LoopCommand.Explore]: {
    required: [],
    optional: [],
  },
  [LoopCommand.Bootstrap]: {
    required: [],
    optional: [],
  },
};

/**
 * Validate that a result bundle contains all required files for a command.
 * Returns the list of missing required files, or an empty array if valid.
 */
export function validateResultBundle(
  command: string,
  presentFiles: string[]
): string[] {
  const manifest = ResultBundle[command as LoopCommand];
  if (!manifest) {
    return [];
  }
  const fileSet = new Set(presentFiles);
  return manifest.required.filter((f) => !fileSet.has(f));
}
