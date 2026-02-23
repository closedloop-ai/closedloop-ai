/**
 * Protocol and key types for the workflow command handler registry.
 *
 * Follows the same Open-Closed pattern as the zip extractor registry:
 * new commands and conclusions are added by registering entries in
 * WORKFLOW_HANDLER_MAP — resolveHandler never changes.
 */

import type { SymphonyCommand } from "@repo/api/src/types/artifact";
import type { TransactionClient } from "@repo/database/generated/internal/prismaNamespace";
import type { ZipContentBag } from "../../extractors/types";
import type { WorkflowContext } from "../../types";

/**
 * Workflow conclusion values as reported by GitHub.
 * Extended here as a string union so callers can handle values beyond
 * the two common cases without losing type safety on the handled ones.
 */
export type WorkflowConclusion =
  | "success"
  | "failure"
  | (string & Record<never, never>);

/**
 * Composite key encoding both command and conclusion.
 * "*" is the wildcard command — matches any command not explicitly registered.
 *
 * Examples: "execute:success", "plan:failure", "*:success"
 */
export type HandlerMapKey = `${SymphonyCommand | "*"}:${string}`;

/**
 * Unified protocol for all workflow outcome handlers.
 *
 * Both success and failure paths implement this interface so they are
 * fully interchangeable in the registry and resolver.
 *
 * Conventions:
 * - `tx`  — outer transaction. Handlers requiring atomicity with the
 *            gitHubActionRun status update (plan, failure) use it.
 *            Handlers with independent transaction semantics (execute)
 *            may ignore `tx` and open their own.
 * - `bag` — extracted zip content. Empty for failure paths (no artifacts
 *            are downloaded when a workflow fails).
 * - `ctx.htmlUrl` — GitHub Actions run URL, consumed by failure handlers.
 */
export type WorkflowHandler = {
  handle(
    tx: TransactionClient,
    ctx: WorkflowContext,
    bag: ZipContentBag
  ): Promise<void>;
};
