import { z } from "zod";

const cloudBranchIdSchema = z.uuid();

/** Whether a Branch id satisfies the persisted cloud Artifact UUID contract. */
export function isValidCloudBranchId(value: string): boolean {
  return cloudBranchIdSchema.safeParse(value).success;
}
