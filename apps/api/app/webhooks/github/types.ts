import type {
  WorkflowRunCompletedEvent,
  WorkflowRunInProgressEvent,
  WorkflowRunRequestedEvent,
} from "@octokit/webhooks-types";
import type { SymphonyCommand } from "@repo/api/src/types/artifact";

/**
 * Context extracted from GitHub workflow correlation ID and action run data.
 * Used throughout webhook processing to track the source artifact and workstream.
 */
export type WorkflowContext = {
  correlationId: string;
  artifactId: string;
  workstreamId: string;
  runId: number;
  /** GitHub Actions run URL — consumed by failure handlers. */
  htmlUrl: string;
  command?: SymphonyCommand;
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
