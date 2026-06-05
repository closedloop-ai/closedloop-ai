// Response type for POST /plans/start-loop-from-local

export type StartPlanLoopResponse =
  | {
      outcome: "launched";
      loopId: string;
      artifactId: string;
      artifactSlug: string;
    }
  | {
      outcome: "already-running";
      loopId: string;
      artifactId: string;
      localRepoPath: string;
      artifactSlug: string;
    }
  | { outcome: "needs-selection"; artifacts: { id: string; title: string }[] }
  | {
      outcome: "invalid-artifact";
      existingArtifacts: { id: string; title: string }[];
    }
  | { outcome: "error"; reason: "missing-local-path" };
