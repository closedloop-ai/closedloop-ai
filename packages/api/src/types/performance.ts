// Performance event types for perf.jsonl parsing and summary visualization.
// These types match the structured JSON lines format in perf.jsonl run artifacts.

/**
 * An iteration-level performance event.
 *
 * Attributes:
 * - event: Discriminant field (always "iteration")
 * - run_id: Unique identifier for the run
 * - iteration: Iteration number (1-based)
 * - duration_s: Duration of this iteration in seconds
 * - status: Outcome status of the iteration
 * - started_at: ISO 8601 timestamp when the iteration started
 * - ended_at: ISO 8601 timestamp when the iteration ended
 * - claude_exit_code: Exit code from the Claude CLI invocation
 */
export type IterationEvent = {
  event: "iteration";
  run_id: string;
  iteration: number;
  duration_s: number;
  status: string;
  started_at: string;
  ended_at: string;
  claude_exit_code: number;
};

/**
 * A pipeline step-level performance event.
 *
 * Attributes:
 * - event: Discriminant field (always "pipeline_step")
 * - run_id: Unique identifier for the run
 * - iteration: Iteration number in which this step ran
 * - step: Step index within the pipeline
 * - step_name: Human-readable name of the pipeline step
 * - duration_s: Duration of this step in seconds
 * - skipped: Whether this step was skipped
 * - exit_code: Exit code from the step execution
 * - started_at: ISO 8601 timestamp when the step started
 * - ended_at: ISO 8601 timestamp when the step ended
 */
export type PipelineStepEvent = {
  event: "pipeline_step";
  run_id: string;
  iteration: number;
  step: number;
  step_name: string;
  duration_s: number;
  skipped: boolean;
  exit_code: number;
  started_at: string;
  ended_at: string;
};

/**
 * An agent invocation performance event.
 *
 * Attributes:
 * - event: Discriminant field (always "agent")
 * - run_id: Unique identifier for the run
 * - iteration: Iteration number in which this agent ran
 * - agent_id: Unique identifier for this agent invocation
 * - agent_type: Type/class of agent
 * - agent_name: Human-readable name of the agent
 * - started_at: ISO 8601 timestamp when the agent started
 * - ended_at: ISO 8601 timestamp when the agent ended
 * - duration_s: Duration of this agent invocation in seconds
 */
export type AgentEvent = {
  event: "agent";
  run_id: string;
  iteration: number;
  agent_id: string;
  agent_type: string;
  agent_name: string;
  started_at: string;
  ended_at: string;
  duration_s: number;
};

/**
 * Discriminated union of all performance event types.
 * Use the `event` field as the discriminant to narrow to a specific type.
 */
export type PerfEvent = IterationEvent | PipelineStepEvent | AgentEvent;

/**
 * Aggregated performance breakdown for a single agent type/name.
 *
 * Attributes:
 * - agentName: Human-readable name of the agent
 * - agentType: Type/class of agent
 * - totalDurationS: Cumulative duration across all invocations in seconds
 * - callCount: Number of times this agent was invoked
 */
export type AgentBreakdown = {
  agentName: string;
  agentType: string;
  totalDurationS: number;
  callCount: number;
};

/**
 * Aggregated performance breakdown for a single pipeline step.
 *
 * Attributes:
 * - stepName: Human-readable name of the pipeline step
 * - callCount: Total number of times this step was invoked (including skipped)
 * - skipCount: Number of times this step was skipped
 * - totalDurationS: Cumulative duration across all executions in seconds
 */
export type PipelineStepBreakdown = {
  stepName: string;
  callCount: number;
  skipCount: number;
  totalDurationS: number;
};

/**
 * Summarized performance data aggregated from all perf events.
 *
 * Attributes:
 * - totalIterations: Total number of iterations in the run
 * - totalDurationS: Total wall-clock duration across all iterations in seconds
 * - agentBreakdown: Per-agent aggregated performance stats
 * - pipelineStepBreakdown: Per-pipeline-step aggregated performance stats
 */
export type PerfSummary = {
  totalIterations: number;
  totalDurationS: number;
  agentBreakdown: AgentBreakdown[];
  pipelineStepBreakdown: PipelineStepBreakdown[];
};

/**
 * API response wrapper for performance data.
 * Returns the summary, or null if perf.jsonl not found.
 */
export type PerformanceDataResponse =
  | { status: "success"; data: PerfSummary }
  | { status: "not_found"; data: null };
