/**
 * FilterToken — application-side constants for the Datadog log-to-metric
 * pipeline filter contract. Each value is the literal free-text token the
 * corresponding pipeline rule searches for in the emitted JSON message.
 *
 * These constants are the single source of truth for the symphony-alpha side
 * of the pipeline contract. Both emit sites and test assertions import from
 * here so that a token change requires exactly one file change.
 *
 * Cross-repo invariant: these values must match the filter strings in the
 * `cl-tofu-aws-live` pipeline definitions. Any change here requires a paired
 * PR in that repo.
 */
export const FilterToken = {
  CommandQueued: "command_queued",
  CommandDispatched: "command_dispatched",
  CommandReplay: "command_replay",
  WorkItemDroppedExpired: "work_item_dropped_expired",
  // loop.runner.* metrics — operator-facing loop runner observability
  LoopRunnerRefreshAttempt: "loop.runner.refresh.attempt",
  LoopRunnerRefreshFailure: "loop.runner.refresh.failure",
  LoopRunnerHeartbeatLag: "loop.runner.heartbeat.lag",
  LoopRunnerHeartbeatAccepted: "loop.runner.heartbeat.accepted",
  LoopRunnerReapTransition: "loop.runner.reap.transition",
  LoopRunnerReapReversed: "loop.runner.reap.reversed",
  LoopRunnerZombieDetector: "loop.runner.zombie_detector",
} as const;

export type FilterToken = (typeof FilterToken)[keyof typeof FilterToken];
