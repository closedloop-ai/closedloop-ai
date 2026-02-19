/**
 * Shape of execution-result.json produced by run-loop.sh / harness-agent.
 * Consumed by both the GitHub Actions webhook (zip-parser) and the
 * Loops/ECS artifact ingestion pipeline.
 */
export type ExecutionResult = {
  has_changes: boolean;
  pr_url: string;
  pr_number: string | number; // GitHub Actions outputs as string
  pr_title?: string;
  branch_name: string;
  base_ref?: string; // Workflow uses base_ref, not base_branch
  base_branch?: string; // Legacy/alternative field name
  github_id?: number;
  commit_sha?: string;
};
