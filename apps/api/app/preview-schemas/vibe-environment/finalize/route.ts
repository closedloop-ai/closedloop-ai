import "server-only";

import { z } from "zod";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { personRequestShape } from "../person-request";
import { vibeEnvironmentHandler } from "../respond";
import { finalizeVibeEnvironment } from "../service";

/**
 * ISS-12056: loads every staged row into the seeded vibe environment in one
 * transaction, binding the seeded org to the person's stage Clerk org (found
 * from their email) and, ISS-12135, handing the seed's signed-in person to
 * them (`service/adopt-person.ts`), then points each seeded transcript at its
 * uploaded object and marks the environment ready. Reports whether the person's Clerk
 * role in that org is an admin role.
 */

export const maxDuration = 300;

const finalizeRequestValidator = z.object({
  branch: repoBranchSchema,
  ...personRequestShape,
});

export const POST = withRequestCompleted(
  vibeEnvironmentHandler(
    {
      validator: finalizeRequestValidator,
      unexpectedFailureMessage:
        "Failed to finalize a vibe environment: the request failed before the seed was loaded; see the api-stage logs for this request",
    },
    (body) =>
      finalizeVibeEnvironment(body.branch, {
        personEmail: body.personEmail,
        ...(body.clerkOrgId === undefined
          ? {}
          : { clerkOrgId: body.clerkOrgId }),
      })
  )
);
