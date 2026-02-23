import { SymphonyCommand } from "@repo/api/src/types/artifact";
import type { TransactionClient } from "@repo/database/generated/internal/prismaNamespace";
import { log } from "@repo/observability/log";
import type { ZipContentBag } from "../../extractors/types";
import type { WorkflowContext } from "../../types";
import { executeSuccessHandler } from "./execute-handler";
import { workflowFailureHandler } from "./failure-handler";
import { PLAN_HANDLER_COMMANDS, planSuccessHandler } from "./plan-handler";
import type {
  HandlerMapKey,
  WorkflowConclusion,
  WorkflowHandler,
} from "./types";

/**
 * The single extension point for workflow outcome routing.
 *
 * Lookup key format: `"${command}:${conclusion}"` or `"*:${conclusion}"` for defaults.
 *
 * To extend:
 *   - New command, default success behavior → no entry needed ("*:success" covers it)
 *   - New command, custom success behavior  → add `"newcmd:success": myHandler`
 *   - New command, custom failure behavior  → add `"newcmd:failure": myHandler`
 *   - New conclusion type                  → add `"*:newtimeout": timeoutHandler`
 *
 * resolveHandler is never modified — only this map is.
 */
export const WORKFLOW_HANDLER_MAP: ReadonlyMap<HandlerMapKey, WorkflowHandler> =
  new Map<HandlerMapKey, WorkflowHandler>([
    // Success: per-command overrides
    [`${SymphonyCommand.Execute}:success`, executeSuccessHandler],

    // Success: default (plan, chat, request_changes and any future commands)
    ...PLAN_HANDLER_COMMANDS.map(
      (cmd) =>
        [`${cmd}:success`, planSuccessHandler] as [
          HandlerMapKey,
          WorkflowHandler,
        ]
    ),
    ["*:success", planSuccessHandler],

    // Failure: same handler for all commands
    ["*:failure", workflowFailureHandler],
  ]);

/** Safety-net handler — logs a warning when the map has a gap. */
const noopHandler: WorkflowHandler = {
  handle(
    _tx: TransactionClient,
    ctx: WorkflowContext,
    _bag: ZipContentBag
  ): Promise<void> {
    log.warn("[resolveHandler] No handler registered for command/conclusion", {
      command: ctx.command,
    });
    return Promise.resolve();
  },
};

/**
 * Resolves the correct WorkflowHandler for a given (command, conclusion) pair.
 *
 * Lookup order:
 *   1. Exact key  — `${command}:${conclusion}` (command-specific override)
 *   2. Wildcard   — `*:${conclusion}` (default for this conclusion)
 *   3. Noop       — safety net; should never be reached with a complete map
 *
 * This function never needs to change — extend WORKFLOW_HANDLER_MAP instead.
 */
export function resolveHandler(
  command: SymphonyCommand | undefined,
  conclusion: WorkflowConclusion
): WorkflowHandler {
  const exactKey: HandlerMapKey | undefined = command
    ? `${command}:${conclusion}`
    : undefined;

  return (
    (exactKey !== undefined ? WORKFLOW_HANDLER_MAP.get(exactKey) : undefined) ??
    WORKFLOW_HANDLER_MAP.get(`*:${conclusion}`) ??
    noopHandler
  );
}
