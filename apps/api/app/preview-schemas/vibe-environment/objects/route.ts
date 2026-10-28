import "server-only";

import { z } from "zod";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { VIBE_ENVIRONMENT_OBJECT_KEY_MAX_LENGTH } from "../constants";
import { vibeEnvironmentHandler } from "../respond";
import { presignVibeEnvironmentObject } from "../service";

/**
 * ISS-12056: a presigned PUT for one seeded transcript, under the vibe
 * environment's own key prefix in the shared transcripts bucket. The runner
 * uploads the bytes straight to S3 with the checksum the seed recorded, which
 * S3 verifies.
 */

export const maxDuration = 30;

const objectRequestValidator = z.object({
  branch: repoBranchSchema,
  key: z.string().min(1).max(VIBE_ENVIRONMENT_OBJECT_KEY_MAX_LENGTH),
  checksumCrc64Nvme: z.base64().min(1).max(64),
});

export const POST = withRequestCompleted(
  vibeEnvironmentHandler(
    {
      validator: objectRequestValidator,
      unexpectedFailureMessage:
        "Failed to presign a seeded transcript upload; see the api-stage logs for this request",
    },
    (body) =>
      presignVibeEnvironmentObject(
        body.branch,
        body.key,
        body.checksumCrc64Nvme
      )
  )
);
