import { GeneratePrdEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { goneResponse } from "@/lib/route-utils";

/**
 * Compatibility tombstone for the removed PRD-generation agent (ISS-8943).
 *
 * A browser tab still on a pre-ISS-8943 bundle can keep POSTing here until it
 * reloads. Answer with a non-retryable 410 rather than let the path 404 into a
 * generic, retryable-looking failure. Nothing is parsed, streamed, or persisted.
 */
export const POST = withRequestCompleted(() =>
  goneResponse(GeneratePrdEndpointRemoval.Message, {
    code: GeneratePrdEndpointRemoval.Code,
  })
);
