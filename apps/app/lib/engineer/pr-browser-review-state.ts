type ReviewRestoreSeed = {
  config?: {
    instructions?: string;
    model?: string;
    reasoningEffort?: string;
    reviewMode?: "base" | "uncommitted";
  };
  provider?: string;
  log?: string;
  status?: string;
};

/**
 * `useReviewExecution` treats any `initialOutput` as a completed review.
 * Running reviews must therefore not hydrate with partial log output.
 */
export function normalizeReviewRestoreSeed(
  data: ReviewRestoreSeed
): ReviewRestoreSeed {
  if (data.status === "running") {
    return { ...data, log: undefined };
  }
  return data;
}
