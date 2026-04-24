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

export const BRANCH_NAME_REGEX = /^[A-Za-z0-9._/-]+$/;

export const RepoExecutionResultBaseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    fullName: z.string(),
    prUrl: z.string(),
    prNumber: z.number(),
    branchName: z.string(),
    baseBranch: z.string(),
    hasChanges: z.boolean(),
    prTitle: z.string().optional(),
    commitSha: z.string().optional(),
    githubId: z.number().optional(),
  }),
  z.object({
    status: z.literal("skipped"),
    fullName: z.string(),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("failed"),
    fullName: z.string(),
    error: z.string(),
  }),
]);

export const RepoExecutionResultSchema =
  RepoExecutionResultBaseSchema.superRefine((val, ctx) => {
    if (val.status !== "success") {
      return;
    }
    const expectedUrl = `https://github.com/${val.fullName}/pull/${val.prNumber}`;
    if (val.prUrl !== expectedUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prUrl does not match canonical format",
        path: ["prUrl"],
      });
    }
    if (!BRANCH_NAME_REGEX.test(val.branchName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "branchName contains invalid characters",
        path: ["branchName"],
      });
    }
    if (!BRANCH_NAME_REGEX.test(val.baseBranch)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "baseBranch contains invalid characters",
        path: ["baseBranch"],
      });
    }
  });

export type RepoExecutionResult = z.infer<typeof RepoExecutionResultSchema>;

/**
 * Factory that builds a `z.array(RepoExecutionResultSchema)` validator with an
 * optional authorization allowlist.
 *
 * **Performance note:** Construct the schema once per authorized-repo set and
 * reuse it across calls. Do not invoke this function inside a per-request
 * handler — the `superRefine` closure captures the `Set` reference, so a
 * single construction is sufficient for the lifetime of that set.
 *
 * @param authorizedRepos - When provided, every entry's `fullName` must be a
 *   member of this set. Omit (or pass `undefined`) to skip the allowlist check.
 */
export function createRepoExecutionResultsSchema(
  authorizedRepos?: Set<string>
) {
  return z.array(RepoExecutionResultSchema).superRefine((entries, ctx) => {
    if (!authorizedRepos) {
      return;
    }
    entries.forEach((entry, index) => {
      if (!authorizedRepos.has(entry.fullName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "fullName not in authorized repo set",
          path: [index, "fullName"],
        });
      }
    });
  });
}

export const RepoExecutionResultsSchema = createRepoExecutionResultsSchema();

export const ExecutionResultV2Schema = z.object({
  schemaVersion: z.literal(2),
  results: z.array(RepoExecutionResultSchema),
});

export type ExecutionResultV2 = z.infer<typeof ExecutionResultV2Schema>;

export function normalizeV1ExecutionResult(
  result: ExecutionResult & { error?: string },
  fullName: string
): RepoExecutionResult[] {
  if (result.error) {
    return [{ status: "failed" as const, fullName, error: result.error }];
  }
  if (!result.hasChanges) {
    return [{ status: "skipped" as const, fullName, reason: "no_changes" }];
  }

  const prNumber = result.prNumber;
  const branchName = result.branchName;
  const baseBranch = result.baseBranch ?? result.baseRef;
  const prUrl = result.prUrl;

  if (
    prUrl == null ||
    prNumber == null ||
    branchName == null ||
    baseBranch == null
  ) {
    return [
      {
        status: "failed" as const,
        fullName,
        error:
          "execution reported hasChanges but missing required PR fields (prUrl, prNumber, branchName, baseBranch)",
      },
    ];
  }

  const entry: RepoExecutionResult & { status: "success" } = {
    status: "success",
    fullName,
    prUrl,
    prNumber,
    branchName,
    baseBranch,
    hasChanges: true,
  };
  if (result.prTitle != null) {
    entry.prTitle = result.prTitle;
  }
  if (result.commitSha != null) {
    entry.commitSha = result.commitSha;
  }
  if (result.githubId != null) {
    entry.githubId = result.githubId;
  }
  return [entry];
}

export function normalizeV2ExecutionResult(
  envelope: ExecutionResultV2
): RepoExecutionResult[] {
  return envelope.results;
}

export function getPrimaryRepoResult(
  results: RepoExecutionResult[],
  primaryFullName: string
): RepoExecutionResult | null {
  return results.find((r) => r.fullName === primaryFullName) ?? null;
}
