/**
 * ISS-5262 (closedloop-ai-stage review) — the COMPILE-TIME half of the shutdown
 * sentinel contract.
 *
 * `withDb` widens every `desktop:db:*` / `desktop:scheduled-tasks:*` (and the
 * other guarded namespaces) handler result to
 * `TResult | DbHostShuttingDownResult`. Both preload bridges then cast
 * (`invoke(...) as Promise<T>`), which erases that union again — so a bridge
 * that forgot `rejectIfDbHostShuttingDown` typechecked and shipped the
 * payload-free sentinel to a caller expecting data: a truthy object read as a
 * successful delete, a non-array spread into a table.
 *
 * A cast can never be type-checked, so the enforcement sits on the CHANNEL
 * instead: an unguarded `invoke` declares
 * `channel: TChannel & NotDbGuarded<TChannel>`, which collapses to `never` for a
 * guarded namespace. This file is compiled by `typecheck:type-tests`, so it is
 * the executable proof that the constraint actually bites — every
 * `@ts-expect-error` below FAILS THE BUILD if the guard ever stops rejecting
 * that channel.
 */
import type { NotDbGuarded } from "../src/shared/db-host-shutdown-contract.js";
import { ScheduledTasksIpcChannel } from "../src/shared/scheduled-tasks-channel.js";
import { SHARED_AGENT_COMPONENTS_IPC_CHANNELS } from "../src/shared/shared-agent-components-contract.js";
import { SHARED_AGENT_SESSIONS_IPC_CHANNELS } from "../src/shared/shared-agent-sessions-contract.js";
import { SHARED_BRANCHES_IPC_CHANNELS } from "../src/shared/shared-branches-contract.js";
import { SHARED_TRACE_COMMENTS_IPC_CHANNELS } from "../src/shared/shared-trace-comments-contract.js";

/** Stands in for the preload's unguarded `invoke` (identical constraint). */
declare function invokeUnguarded<TChannel extends string>(
  channel: TChannel & NotDbGuarded<TChannel>,
  ...args: unknown[]
): Promise<unknown>;

/** A channel with no `withDb` handler behind it stays perfectly usable. */
export const unguardedChannelsStillCompile: Promise<unknown>[] = [
  invokeUnguarded("desktop:get-settings"),
  invokeUnguarded("desktop:get-runtime-status"),
  invokeUnguarded("desktop:pack:get-analytics", "pack-id"),
  invokeUnguarded("desktop:coaching:install", "distribution-id"),
];

/**
 * Every guarded namespace is rejected. Each `@ts-expect-error` is an assertion:
 * remove the constraint and `tsc` fails here with "unused @ts-expect-error".
 */
export const guardedChannelsAreCompileErrors: Promise<unknown>[] = [
  // @ts-expect-error — desktop:db:* is withDb-backed; use the guarded helper.
  invokeUnguarded("desktop:db:get-sessions"),
  // @ts-expect-error — desktop:scheduled-tasks:* is withDb-backed.
  invokeUnguarded(ScheduledTasksIpcChannel.RunNow, "task-id"),
  // @ts-expect-error — desktop:shared-agent-sessions:* is withDb-backed.
  invokeUnguarded(SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage),
  // @ts-expect-error — desktop:shared-branches:* is withDb-backed.
  invokeUnguarded(SHARED_BRANCHES_IPC_CHANNELS.detail, "branch-id"),
  // @ts-expect-error — desktop:shared-trace-comments:* is withDb-backed.
  invokeUnguarded(SHARED_TRACE_COMMENTS_IPC_CHANNELS.delete, "comment-id"),
  // @ts-expect-error — the agent-components channels live under desktop:db:*.
  invokeUnguarded(SHARED_AGENT_COMPONENTS_IPC_CHANNELS.list),
];
