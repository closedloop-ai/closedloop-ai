import { z } from "zod";

/**
 * Execution result written by the EXECUTE command to execution-result.json.
 *
 * Normalizes differences between ECS (empty strings, base_ref always present)
 * and Electron (strict validation, no base_ref) into a canonical schema
 * that uses null instead of empty strings for absent values.
 */
export type ExecutionResult = {
  has_changes: boolean;
  pr_url: string | null;
  pr_number: number | null;
  branch_name: string | null;
  base_ref: string | null;
  commit_sha: string | null;
};

export const ExecutionResultSchema = z.object({
  has_changes: z.boolean(),
  pr_url: z.string().nullable(),
  pr_number: z.number().nullable(),
  branch_name: z.string().nullable(),
  base_ref: z.string().nullable(),
  commit_sha: z.string().nullable(),
});
