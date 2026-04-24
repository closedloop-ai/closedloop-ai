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
  documentId: string;
  workstreamId: string;
  organizationId: string;
  runId: string;
  command?: string;
  repositoryId?: string;
  actionRunId?: string;
  /** Full repository name (owner/repo) from the GitHub webhook event payload. */
  fullName?: string;
};

/**
 * Union type for all workflow_run webhook events we process.
 */
export type WorkflowRunEvent =
  | WorkflowRunCompletedEvent
  | WorkflowRunInProgressEvent
  | WorkflowRunRequestedEvent;
