import type {
  WorkflowRunCompletedEvent,
  WorkflowRunInProgressEvent,
  WorkflowRunRequestedEvent,
} from "@octokit/webhooks-types";

/**
 * Context extracted from GitHub workflow correlation ID and action run data.
 * Used throughout webhook processing to track the source artifact and workstream.
 */
export type WorkflowContext = {
  correlationId: string;
  artifactId: string;
  workstreamId: string;
  runId: string;
  command?: string;
  repositoryId?: string;
  actionRunId?: string;
};

/**
 * Union type for all workflow_run webhook events we process.
 */
export type WorkflowRunEvent =
  | WorkflowRunCompletedEvent
  | WorkflowRunInProgressEvent
  | WorkflowRunRequestedEvent;

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
