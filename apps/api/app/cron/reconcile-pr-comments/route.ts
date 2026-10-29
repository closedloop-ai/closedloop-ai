import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { createReconcilePrCommentsCronHandler } from "./handler";

// A fan-out over up to RECONCILE_PR_COMMENTS_BATCH pull requests, each reading
// complete provider lists; the same budget as reconcile-pull-requests.
export const maxDuration = 300;

/** Scheduled every 15 minutes in apps/api/vercel.json. */
export const GET = withRequestCompleted(createReconcilePrCommentsCronHandler());
