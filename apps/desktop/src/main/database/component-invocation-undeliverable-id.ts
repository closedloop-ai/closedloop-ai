/**
 * @file component-invocation-undeliverable-id.ts
 * @description The generation identity for an invocation set that HAS no
 * canonical one.
 *
 * `computeAgentComponentInvocationGenerationId` refuses two kinds of input: a
 * set past the wire limits, and (ISS-6889) one whose items collide on
 * `externalInvocationId` once the wire boundary's trim is applied. Neither may
 * abort the caller — `loadAgentComponentInvocationCompleteGeneration` runs
 * inside the import/rebuild `$transaction`, and a throw there rolls back the
 * whole session materialization, which is sync data taking down a core ingest
 * flow (`src/main/sync/AGENTS.md`, invariant 8).
 *
 * So the generation still gets an id, and `buildInvocationSyncParts` records the
 * real reason as a dead-lettered outbox row. The id only has to be STABLE: the
 * per-session cursor is compared against it, and that comparison is what makes
 * the dead-letter recorded exactly ONCE instead of rewritten on every pass.
 *
 * Lives outside `component-invocations.ts` because that file is on the
 * shrink-only `noExcessiveLinesPerFile` grandfather list, and this is a pure
 * function of its inputs with no database dependency.
 */

import { createHash } from "node:crypto";
import type { AgentComponentInvocationSyncItem } from "@repo/api/src/types/agent-component-invocation";
import {
  AgentComponentInvocationSyncPayloadDuplicateIdError,
  AgentComponentInvocationSyncPayloadLimitError,
} from "../agent-sync/agent-component-invocation-sync-payload.js";

/**
 * Distinct hash namespaces on purpose. An oversized set and a collided set are
 * different generations of the same session; sharing one hash space would let
 * the per-session cursor mistake the second for the first and skip recording it.
 */
const UndeliverableInvocationSetNamespace = {
  Oversized: "oversized-agent-component-invocations:v1",
  Collided: "collided-agent-component-invocations:v1",
} as const;
type UndeliverableInvocationSetNamespace =
  (typeof UndeliverableInvocationSetNamespace)[keyof typeof UndeliverableInvocationSetNamespace];

/**
 * A stable id for an invocation set that has no canonical generation id.
 *
 * Rethrows anything other than the two declared conditions: this fallback exists
 * for the cases it names, and laundering an unrecognized failure would queue a
 * generation under an id nothing can explain.
 */
export function undeliverableInvocationSetId(
  error: unknown,
  sessionId: string,
  items: readonly AgentComponentInvocationSyncItem[]
): string {
  const hash = createHash("sha256");
  hash.update(`${namespaceForUndeliverable(error)}\0`);
  hash.update(sessionId);
  for (const item of items) {
    hash.update("\0");
    hash.update(JSON.stringify(item));
  }
  return hash.digest("hex");
}

function namespaceForUndeliverable(
  error: unknown
): UndeliverableInvocationSetNamespace {
  if (error instanceof AgentComponentInvocationSyncPayloadLimitError) {
    return UndeliverableInvocationSetNamespace.Oversized;
  }
  if (error instanceof AgentComponentInvocationSyncPayloadDuplicateIdError) {
    return UndeliverableInvocationSetNamespace.Collided;
  }
  throw error;
}
