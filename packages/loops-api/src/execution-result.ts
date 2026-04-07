import { z } from "zod";

/**
 * Execution result produced by the EXECUTE command.
 *
 * TypeScript properties use camelCase. The on-disk format (execution-result.json)
 * uses snake_case — use ExecutionResultFileSchema + parseExecutionResultFile()
 * when reading from disk.
 */
export type ExecutionResult = {
  hasChanges: boolean;
  prUrl: string | null;
  prNumber: number | null;
  prTitle: string | null;
  branchName: string | null;
  baseRef: string | null;
  baseBranch: string | null;
  commitSha: string | null;
  githubId: number | null;
};

export const ExecutionResultSchema = z.object({
  hasChanges: z.boolean(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  prTitle: z.string().nullable(),
  branchName: z.string().nullable(),
  baseRef: z.string().nullable(),
  baseBranch: z.string().nullable(),
  commitSha: z.string().nullable(),
  githubId: z.number().nullable(),
});

/**
 * On-disk format (snake_case) as written by the ECS harness and Electron gateway
 * to execution-result.json.
 *
 * Both harnesses always write string values for pr_url, branch_name, and base_ref
 * (empty string "" when there is no value, never null). parseExecutionResultFile()
 * normalizes these sentinels to null in the canonical camelCase type.
 */
export const ExecutionResultFileSchema = z.object({
  has_changes: z.boolean(),
  pr_url: z.string(),
  pr_number: z.union([z.string(), z.number()]),
  pr_title: z.string().optional(),
  branch_name: z.string(),
  base_ref: z.string(),
  base_branch: z.string().optional(),
  commit_sha: z.string().nullish(),
  github_id: z.number().optional(),
});

/** Normalize empty-string/zero sentinels to null. */
function emptyToNull(value: string): string | null {
  return value === "" ? null : value;
}

function prNumberToNull(value: string | number): number | null {
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) || parsed === 0 ? null : parsed;
  }
  return value === 0 ? null : value;
}

/** Parse the on-disk snake_case format into the canonical camelCase type. */
export function parseExecutionResultFile(
  data: unknown
): ExecutionResult | null {
  const result = ExecutionResultFileSchema.safeParse(data);
  if (!result.success) {
    return null;
  }
  const f = result.data;
  return {
    hasChanges: f.has_changes,
    prUrl: emptyToNull(f.pr_url),
    prNumber: prNumberToNull(f.pr_number),
    prTitle: f.pr_title ?? null,
    branchName: emptyToNull(f.branch_name),
    baseRef: emptyToNull(f.base_ref),
    baseBranch: f.base_branch ? emptyToNull(f.base_branch) : null,
    commitSha: f.commit_sha ?? null,
    githubId: f.github_id ?? null,
  };
}
