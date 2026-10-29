import "server-only";

import { z } from "zod";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { VIBE_ENVIRONMENT_ROWS_MAX_BYTES } from "../constants";
import { vibeEnvironmentHandler } from "../respond";
import { stageVibeEnvironmentRows } from "../service";

/**
 * ISS-12056: stages one batch of the runner's seeded rows for one table in the
 * branch's seeded vibe environment. `rows` is the JSON array as text, so no
 * value round-trips through a JavaScript number on its way to Postgres.
 */

export const maxDuration = 60;

/** Postgres identifiers are at most 63 bytes; table names are snake_case. */
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const rowsRequestValidator = z.object({
  branch: repoBranchSchema,
  table: z.string().regex(TABLE_NAME),
  rows: z.string().min(2),
});

export const POST = withRequestCompleted(
  vibeEnvironmentHandler(
    {
      validator: rowsRequestValidator,
      maxBytes: VIBE_ENVIRONMENT_ROWS_MAX_BYTES,
      unexpectedFailureMessage:
        "Failed to stage seeded rows: the request failed before they were staged; see the api-stage logs for this request",
    },
    (body) => stageVibeEnvironmentRows(body.branch, body.table, body.rows)
  )
);
