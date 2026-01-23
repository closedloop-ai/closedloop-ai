import { z } from "zod";

/**
 * Validator for POST /integrations/linear/export
 * Export an approved implementation plan to Linear as individual issues
 */
export const exportToLinearValidator = z.object({
  artifactId: z.uuidv7(),
  teamId: z.string().min(1, "Linear team ID is required"),
});
