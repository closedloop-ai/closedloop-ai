import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { createDocSyncChangesHandler } from "./handler";

/** doc-sync's change callbacks; the caller is verified inside the handler (STS caller identity). */
export const POST = withRequestCompleted(createDocSyncChangesHandler());
