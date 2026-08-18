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
  /**
   * Whether `required` is a COMPLETION CONTRACT rather than a hint (ISS-5872).
   *
   * `true` means the required files are the command's deliverable and are
   * written unconditionally on any real success, so a run that exits 0 without
   * them produced nothing and must terminalize as FAILED — never as COMPLETED
   * with a null error. `false` means `required` describes the usual shape but a
   * legitimate success can omit it, so absence proves nothing.
   *
   * The field is non-optional so a newly added `LoopCommand` cannot inherit an
   * enforcement decision by accident — `Record<LoopCommand, …>` makes `tsc`
   * demand an explicit answer.
   */
  enforceRequired: boolean;
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
    enforceRequired: true,
  },
  [LoopCommand.Execute]: {
    required: [LoopArtifactFile.ExecutionResult],
    optional: [LoopArtifactFile.CodeJudges],
    // NOT enforced, and deliberately so. The EXECUTE prompt instructs the agent
    // "Do NOT write execution-result.json unless you successfully committed AND
    // pushed" (see the commit prompt in symphony-loop.ts), so a run that
    // correctly found nothing to change ends with the file absent. Enforcing
    // here would fail every legitimate no-changes EXECUTE. EXECUTE already has
    // its own honesty guards: the 0-token ghost-loop check and
    // `executeFinalizationStatus`.
    enforceRequired: false,
  },
  [LoopCommand.RequestChanges]: {
    required: [LoopArtifactFile.Plan],
    optional: [
      LoopArtifactFile.PlanMarkdown,
      LoopArtifactFile.OpenQuestions,
      LoopArtifactFile.Judges,
    ],
    // Enforced, but weaker than the others by construction: the harness SEEDS
    // plan.json into the workdir from the inbound plan before an amend run
    // starts, so presence does not prove this run wrote anything. It still
    // catches the unambiguous case — a run that ends with no plan at all,
    // including the legacy plan-source.md path that deletes the seeded file.
    enforceRequired: true,
  },
  [LoopCommand.RequestPrdChanges]: {
    required: [LoopArtifactFile.Prd],
    optional: [],
    enforceRequired: true,
  },
  [LoopCommand.Decompose]: {
    required: [LoopArtifactFile.Features],
    optional: [],
    enforceRequired: true,
  },
  [LoopCommand.GeneratePrd]: {
    required: [LoopArtifactFile.Prd],
    optional: [],
    enforceRequired: true,
  },
  [LoopCommand.EvaluatePrd]: {
    required: [LoopArtifactFile.PrdJudges],
    optional: [],
    enforceRequired: true,
  },
  [LoopCommand.EvaluatePlan]: {
    required: [LoopArtifactFile.PlanJudges],
    optional: [],
    enforceRequired: true,
  },
  [LoopCommand.EvaluateCode]: {
    required: [LoopArtifactFile.CodeJudges],
    optional: [],
    enforceRequired: true,
  },
  [LoopCommand.EvaluateFeature]: {
    required: [LoopArtifactFile.FeatureJudges],
    optional: [],
    enforceRequired: true,
  },
  [LoopCommand.Chat]: {
    required: [],
    optional: [],
    enforceRequired: false,
  },
  [LoopCommand.Explore]: {
    required: [],
    optional: [],
    enforceRequired: false,
  },
  [LoopCommand.Bootstrap]: {
    required: [],
    optional: [],
    enforceRequired: false,
  },
  [LoopCommand.Manual]: {
    required: [],
    optional: [],
    enforceRequired: false,
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

/**
 * Required files a command OWED and did not produce (ISS-5872).
 *
 * Identical to `validateResultBundle` except that it returns `[]` for commands
 * whose manifest sets `enforceRequired: false`, where an absent required file
 * is a legitimate outcome rather than a broken run. Callers deciding whether a
 * loop may terminalize as COMPLETED must use THIS function. `validateResultBundle`
 * is the raw manifest diff and answers a different question — "does this bundle
 * match the manifest" — which is why it stays exported and separately tested.
 */
export function findUnproducedRequiredArtifacts(
  command: string,
  presentFiles: string[]
): string[] {
  const manifest = ResultBundle[command as LoopCommand];
  if (!manifest?.enforceRequired) {
    return [];
  }
  return validateResultBundle(command, presentFiles);
}

/**
 * Operator-facing message for a run that exited successfully without writing
 * the artifact it exists to produce. Names the command and every missing file
 * so the next move is obvious from the error alone — a generic failure here is
 * barely better than the false success it replaces.
 */
export function missingRequiredArtifactsMessage(
  command: string,
  missing: readonly string[]
): string {
  return `${command} loop exited successfully but produced no ${missing.join(", ")} — required output is missing, so the loop did not complete its work`;
}
