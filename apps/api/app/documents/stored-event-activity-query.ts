import { ARTIFACT_ACTIVITY_FEED_MAX_LIMIT } from "@repo/api/src/types/artifact-activity-feed";
import { z } from "zod";
import { isValidStoredEventCursor } from "./artifact-activity-feed-service";

/** Query contract shared by the Session and Branch V1 stored-edit routes. */
export const storedEventActivityQuerySchema = z
  .object({
    cursor: z.string().refine(isValidStoredEventCursor).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ARTIFACT_ACTIVITY_FEED_MAX_LIMIT)
      .optional(),
  })
  .strict();
