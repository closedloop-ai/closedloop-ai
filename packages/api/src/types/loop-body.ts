import type { ContextPackAttachment } from "./context-attachment";
import type { AdditionalRepoRef } from "./loop";

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
  additionalRepos?: AdditionalRepoRef[];
  primaryArtifactId?: string;
};
