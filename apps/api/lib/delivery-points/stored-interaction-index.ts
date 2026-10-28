/**
 * Reading an interaction reference back out of rows PREVIOUS runs stored
 * (ISS-8399).
 *
 * Pensero-facing on purpose, and kept OUT of `delivery-point-store.ts`: the
 * interaction index is a property of Pensero's feed shape (a creator row gets
 * its pull-request number only from a sibling row sharing an interaction id),
 * not of persistence. Keeping it here is what lets the store stay free of every
 * provider package — see `./delivery-point-record`.
 */

import type { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { withDb } from "@repo/database";
import {
  type InteractionIndex,
  type InteractionObservation,
  indexInteractionObservations,
} from "@repo/pensero/delivery-interaction-join";
import { parsePullRequestRefFullName } from "@repo/pensero/delivery-parse";
import { requireDeliveryPointProvider } from "./delivery-point-store";
import { chunked } from "./lookup-chunk";

/**
 * Rebuild the interaction index from rows PREVIOUS runs already resolved.
 *
 * The feed's creator row carries the large values and no pull-request number;
 * only a sibling review row on the same interaction carries one, and the two
 * routinely fall in different windows. An index built from one invocation's
 * rows therefore forgets everything an earlier run established, with two
 * consequences that both write a wrong answer rather than a missing one: a
 * creator row is re-derived as unresolved, and — because the upsert restates
 * every column — a row stored MATCHED last week is OVERWRITTEN as unresolved
 * and has its artifact associations deleted.
 *
 * Seeding from storage closes both: a resolved row is its own record of
 * `(interaction id → owner/repo#number)`, so re-reading it restores exactly the
 * evidence the earlier run had. Contradictions between a stored ref and a fresh
 * one go through the same promotion to `ambiguous` as any other disagreement —
 * a stored answer is evidence, never an override.
 *
 * Scoped to the interaction ids this run actually saw, so the read is bounded
 * by the batch and not by the table.
 */
export async function readStoredInteractionIndex(
  organizationId: string,
  providerId: NumeratorProvider,
  interactionIds: readonly string[]
): Promise<InteractionIndex> {
  const provider = requireDeliveryPointProvider(providerId);
  const wanted = [...new Set(interactionIds)].filter((id) => id.length > 0);
  if (wanted.length === 0) {
    return new Map();
  }

  const observations: InteractionObservation[] = [];
  for (const chunk of chunked(wanted)) {
    const stored = await withDb((db) =>
      db.deliveryPoint.findMany({
        where: {
          organizationId,
          provider,
          providerInteractionId: { in: chunk },
          repositoryFullName: { not: null },
          pullRequestNumber: { not: null },
        },
        select: {
          providerInteractionId: true,
          repositoryFullName: true,
          pullRequestNumber: true,
        },
      })
    );
    for (const row of stored) {
      const observation = toInteractionObservation(row);
      if (observation) {
        observations.push(observation);
      }
    }
  }
  return indexInteractionObservations(observations);
}

/**
 * One stored row → one observation, or `null`. The stored `owner/repo` is
 * PARSED rather than trusted: a value that is not the canonical two-segment
 * shape is not silently split into a repository nobody named.
 */
function toInteractionObservation(row: {
  providerInteractionId: string | null;
  repositoryFullName: string | null;
  pullRequestNumber: number | null;
}): InteractionObservation | null {
  if (!(row.providerInteractionId && row.repositoryFullName)) {
    return null;
  }
  if (row.pullRequestNumber === null) {
    return null;
  }
  const ref = parsePullRequestRefFullName(
    row.repositoryFullName,
    row.pullRequestNumber
  );
  return ref ? { interactionId: row.providerInteractionId, ref } : null;
}
