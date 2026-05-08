// Response type for POST /plans/start-loop-from-local

export type StartPlanLoopResponse =
  | {
      outcome: "launched";
      loopId: string;
      documentId: string;
      documentSlug: string;
    }
  | {
      outcome: "already-running";
      loopId: string;
      documentId: string;
      localRepoPath: string;
      documentSlug: string;
    }
  | { outcome: "needs-selection"; documents: { id: string; title: string }[] }
  | {
      outcome: "invalid-document";
      existingDocuments: { id: string; title: string }[];
    }
  | { outcome: "error"; reason: "missing-local-path" };
