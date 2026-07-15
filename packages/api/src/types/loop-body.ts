import type {
  CodeEvaluationContext,
  ContextPackAgent,
  ContextPackRepoConfig,
  ContextPackSupportingArtifact,
} from "@closedloop-ai/loops-api/context-pack";
import type { HarnessType } from "./compute-target";
import type { ContextPackAttachment } from "./context-attachment";
import type { AdditionalRepoRef } from "./loop";

export const LoopBranchMaterializationRole = {
  Primary: "primary",
  Additional: "additional",
} as const;
export type LoopBranchMaterializationRole =
  (typeof LoopBranchMaterializationRole)[keyof typeof LoopBranchMaterializationRole];

/** Server-owned branch destination for one repo in a Desktop loop. */
export type LoopBranchMaterializationEntry = {
  role: LoopBranchMaterializationRole;
  repositoryFullName: string;
  baseBranch: string;
  branchName: string;
};

/**
 * Additive Desktop loop contract carrying the exact output branches Symphony
 * expects Desktop to materialize and report back through branch-artifact
 * callbacks.
 */
export type LoopBranchMaterializationEnvelope = {
  schemaVersion: 1;
  branches: LoopBranchMaterializationEntry[];
};

/**
 * Typed body for the symphony_loop relay operation dispatched to the
 * electron harness via the desktop gateway.
 *
 * Used by loop-desktop.ts when building the POST body for the
 * /api/gateway/symphony/loop endpoint on the desktop target.
 */
export type LoopBody = {
  loopId: string;
  command: string;
  closedLoopAuthToken: string;
  apiBaseUrl: string;
  /** Loop-scoped S3 prefix used by Desktop for failure support artifacts. */
  s3StateKey?: string;
  artifacts: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
    raw?: Record<string, unknown>;
  }>;
  prompt: string | null;
  repo: {
    fullName: string;
    branch: string;
  } | null;
  committer: {
    name: string;
    email: string;
  } | null;
  artifactSlug: string | null;
  parentLoopId: string | null;
  parentBranchName: string | null;
  parentSessionId: string | null;
  localRepoPath: string | null;
  userContext?: string;
  attachments?: ContextPackAttachment[];
  supportingArtifacts?: ContextPackSupportingArtifact[];
  codeEvaluationContext?: CodeEvaluationContext | null;
  additionalRepos?: AdditionalRepoRef[];
  primaryArtifactId?: string;
  agents?: ContextPackAgent[];
  repoConfigs?: ContextPackRepoConfig[];
  branchMaterialization?: LoopBranchMaterializationEnvelope;
  /** The harness selected for this loop run (e.g. claude, codex). */
  harness?: HarnessType;
};
