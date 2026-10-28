/**
 * The ATTACH stage (ISS-8399): persist matched delivery rows, idempotently.
 *
 * The whole contract of this module is one sentence: **re-extraction must be a
 * no-op.** Delivery windows overlap by design — a window returns rows for pull
 * requests created well before it — so the same provider row arrives again on
 * every pass. Every write is therefore an UPSERT keyed on the provider's own
 * row id, and nothing anywhere adds a stored value to an incoming one. A single
 * `+=` here would inflate the numerator a little on every backfill, forever,
 * and would look like real growth.
 *
 * The artifact associations are RECONCILED rather than appended for the same
 * reason: a re-match that resolves fewer artifacts than last time must leave
 * fewer rows, not a union of both answers.
 *
 * PROVIDER-NEUTRAL BY CONSTRUCTION: this module imports nothing from any
 * provider package. Its input is {@link NormalizedDeliveryPoint}, so a second
 * provider reaches storage by writing an adapter rather than by editing
 * persistence code — see `./delivery-point-record`.
 */

import type { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { withDb } from "@repo/database";
import type { DeliveryMatchTarget } from "./delivery-point-matcher";
import type { NormalizedDeliveryPoint } from "./delivery-point-record";
import { deliveryPointProviderFor } from "./provider-bindings";

/**
 * One row ready to persist: what the provider said, and what it matched to.
 *
 * `point` is the PROVIDER-NEUTRAL record. Nothing in this module reads a
 * provider's own vocabulary, so a second provider reaches storage by writing an
 * adapter, not by editing this file.
 */
export type DeliveryPointWrite = {
  readonly point: NormalizedDeliveryPoint;
  readonly target: DeliveryMatchTarget;
  /** The bridged user, or null when no user in this org carries that email. */
  readonly userId: string | null;
};

/** What one persist pass did. Counts, so a caller can report coverage. */
export type DeliveryPointPersistResult = {
  readonly rowsWritten: number;
  readonly artifactAssociationsWritten: number;
};

/**
 * Persist a batch of matched delivery rows for one organization and provider.
 *
 * Throws when `providerId` is a DERIVED provider (LOC): those have no external
 * rows to store, and silently accepting the call would let a caller believe it
 * had persisted something.
 */
export async function persistDeliveryPoints(
  organizationId: string,
  providerId: NumeratorProvider,
  writes: readonly DeliveryPointWrite[]
): Promise<DeliveryPointPersistResult> {
  const provider = requireDeliveryPointProvider(providerId);

  let rowsWritten = 0;
  let artifactAssociationsWritten = 0;

  for (const write of writes) {
    const { point, target } = write;

    const persisted = {
      itemType: point.itemType,
      rawItemType: point.rawItemType,
      role: point.role,
      rawRole: point.rawRole,
      // The provider's measured value, written as measured. Never summed with
      // whatever is already stored — see the module docstring.
      points: point.points,
      deliveredOn: new Date(`${point.deliveredOn}T00:00:00.000Z`),
      title: point.title,
      providerInteractionId: point.providerInteractionId,
      providerPersonId: point.providerPersonId,
      personEmail: point.personEmail,
      userId: write.userId,
      repositoryFullName: target.repositoryFullName,
      pullRequestNumber: target.pullRequestNumber,
      pullRequestDetailId: target.pullRequestDetailId,
      branchArtifactId: target.branchArtifactId,
      matchOutcome: target.outcome,
    };

    // ONE transaction per point, not one per statement and not one per batch.
    // The association replacement is a DELETE followed by a CREATE: outside a
    // transaction, a failure between them leaves the point persisted with an
    // empty association set that reads as "this row touches no artifacts", and
    // two overlapping backfills can interleave their delete and create halves
    // onto the same point. Per-batch instead of per-point would hold one
    // transaction open across every row and blow the interactive-transaction
    // timeout on a wide window.
    const associationsWritten = await withDb.tx(async (db) => {
      const deliveryPoint = await db.deliveryPoint.upsert({
        where: {
          organizationId_provider_providerItemId: {
            organizationId,
            provider,
            providerItemId: point.providerItemId,
          },
        },
        create: {
          organizationId,
          provider,
          providerItemId: point.providerItemId,
          ...persisted,
        },
        update: persisted,
        select: { id: true },
      });
      return await replaceArtifactAssociations(
        db,
        organizationId,
        deliveryPoint.id,
        target
      );
    });
    rowsWritten += 1;
    artifactAssociationsWritten += associationsWritten;
  }

  return { rowsWritten, artifactAssociationsWritten };
}

/** The narrow slice of the Prisma client this module writes through. */
type DeliveryPointArtifactWriter = {
  deliveryPointArtifact: {
    deleteMany: (args: {
      where: { deliveryPointId: string };
    }) => Promise<{ count: number }>;
    createMany: (args: {
      data: {
        deliveryPointId: string;
        artifactId: string;
        organizationId: string;
        source: DeliveryPointWrite["target"]["artifacts"][number]["source"];
      }[];
    }) => Promise<{ count: number }>;
  };
};

/**
 * Make the stored association set EQUAL the freshly matched one — a full
 * replace, not a merge.
 *
 * Two things a merge would get wrong. A later match that resolves FEWER
 * artifacts must shrink the set, or the row keeps every artifact it was ever
 * thought to touch — including one from a pull request it turned out not to be.
 * And an association whose SOURCE changed must be restated: that label says
 * where the association came from, and an upsert that skips existing rows would
 * leave a stale one in place.
 */
async function replaceArtifactAssociations(
  db: DeliveryPointArtifactWriter,
  organizationId: string,
  deliveryPointId: string,
  target: DeliveryMatchTarget
): Promise<number> {
  await db.deliveryPointArtifact.deleteMany({ where: { deliveryPointId } });
  if (target.artifacts.length === 0) {
    return 0;
  }
  const deduped = new Map(
    target.artifacts.map((association) => [
      association.artifactId,
      association.source,
    ])
  );
  const created = await db.deliveryPointArtifact.createMany({
    data: [...deduped].map(([artifactId, source]) => ({
      deliveryPointId,
      artifactId,
      organizationId,
      source,
    })),
  });
  return created.count;
}

/**
 * The provider's storage key, or a thrown error naming why there is none. A
 * DERIVED provider (LOC) has no external rows, and silently accepting the call
 * would let a caller believe it had persisted something.
 */
export function requireDeliveryPointProvider(providerId: NumeratorProvider) {
  const provider = deliveryPointProviderFor(providerId);
  if (!provider) {
    throw new Error(
      `Numerator provider "${providerId}" is derived from our own data and has no delivery-point rows to persist.`
    );
  }
  return provider;
}
