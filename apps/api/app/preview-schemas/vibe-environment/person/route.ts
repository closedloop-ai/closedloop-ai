import "server-only";

import { z } from "zod";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { personRequestShape } from "../person-request";
import { vibeEnvironmentHandler } from "../respond";
import { checkVibeEnvironmentPerson } from "../service";

/**
 * ISS-12135 bug 19: the person checks finalize makes (one stage Clerk user for
 * the email, the org finalize would bind and an admin role in it), answered
 * before `vibe-environment.yml` spends its seed job. Read-only. An org the
 * server cannot choose answers with the same `clerk_org_ambiguous` code and
 * org list as finalize.
 */

export const maxDuration = 30;

const personRequestValidator = z.object({
  branch: repoBranchSchema,
  ...personRequestShape,
});

export const POST = withRequestCompleted(
  vibeEnvironmentHandler(
    {
      validator: personRequestValidator,
      unexpectedFailureMessage:
        "Failed to check the person for a vibe environment; see the api-stage logs for this request",
    },
    (body) =>
      checkVibeEnvironmentPerson(body.branch, {
        personEmail: body.personEmail,
        ...(body.clerkOrgId === undefined
          ? {}
          : { clerkOrgId: body.clerkOrgId }),
      })
  )
);
