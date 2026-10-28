import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { createSweepDocSyncStateCronHandler } from "./handler";

// The sweep stops itself at a 240 s deadline; this leaves headroom past it.
export const maxDuration = 300;

/** Scheduled daily in apps/api/vercel.json. */
export const GET = withRequestCompleted(createSweepDocSyncStateCronHandler());
