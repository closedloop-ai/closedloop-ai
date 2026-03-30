/**
 * Typed body for the symphony_loop relay operation dispatched to the
 * electron harness via the desktop gateway.
 *
 * Used by loop-desktop.ts when building the POST body for the
 * /api/engineer/symphony/loop endpoint on the desktop target.
 */
export type SymphonyLoopBody = {
  loopId: string;
  command: string;
  closedLoopAuthToken: string;
  apiBaseUrl: string;
  artifacts: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
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
};
