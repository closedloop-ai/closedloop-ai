/**
 * The PENSERO adapter (ISS-8399): Pensero's feed vocabulary → ours.
 *
 * This is the only module in the delivery-points pipeline that knows both
 * vocabularies. Everything downstream of it — the store, the association writer,
 * the stored-index reader — speaks {@link NormalizedDeliveryPoint} and nothing
 * provider-specific, which is what makes a second provider an ADDITIONAL adapter
 * rather than an edit to the persistence code.
 *
 * The two maps are `Record<PenseroDelivery…, …>` on purpose: a new member on the
 * provider contract fails typecheck HERE rather than folding silently into
 * `OTHER`, which on screen is indistinguishable from a kind the provider does
 * not have.
 */

import { DeliveryContributorRole, DeliveryItemType } from "@repo/database";
import {
  PenseroDeliveryItemType,
  PenseroDeliveryRole,
  PenseroInteractionKind,
} from "@repo/pensero/delivery-contract";
import type { ResolvedDeliveryRow } from "@repo/pensero/delivery-interaction-join";
import type { NormalizedDeliveryPoint } from "./delivery-point-record";

/** Wire item type → stored item type. Exhaustive; see the module docstring. */
const STORED_ITEM_TYPE: Record<PenseroDeliveryItemType, DeliveryItemType> = {
  [PenseroDeliveryItemType.PullRequest]: DeliveryItemType.PULL_REQUEST,
  [PenseroDeliveryItemType.PullRequestReview]:
    DeliveryItemType.PULL_REQUEST_REVIEW,
  [PenseroDeliveryItemType.Messaging]: DeliveryItemType.MESSAGING,
  [PenseroDeliveryItemType.Ticket]: DeliveryItemType.TICKET,
  [PenseroDeliveryItemType.Other]: DeliveryItemType.OTHER,
};

/** Wire role → stored role. Exhaustive for the same reason. */
const STORED_ROLE: Record<PenseroDeliveryRole, DeliveryContributorRole> = {
  [PenseroDeliveryRole.Creator]: DeliveryContributorRole.CREATOR,
  [PenseroDeliveryRole.Reviewer]: DeliveryContributorRole.REVIEWER,
  [PenseroDeliveryRole.Assignee]: DeliveryContributorRole.ASSIGNEE,
  [PenseroDeliveryRole.Other]: DeliveryContributorRole.OTHER,
};

/**
 * Translate one interaction-resolved Pensero row into the neutral record.
 *
 * Only a PULL-REQUEST interaction id is carried forward. A Pensero `ticket`
 * interaction is the provider's own ticketing entity, not one of our artifacts,
 * and storing its id in the column the pull-request carry-forward reads back
 * would let a ticket id be matched against pull-request references.
 */
export function toNormalizedDeliveryPoint(
  resolved: ResolvedDeliveryRow
): NormalizedDeliveryPoint {
  const row = resolved.row;
  return {
    providerItemId: row.itemId,
    providerInteractionId:
      row.interaction?.kind === PenseroInteractionKind.PullRequest
        ? row.interaction.id
        : null,
    itemType: STORED_ITEM_TYPE[row.itemType],
    rawItemType: row.rawItemType,
    role: STORED_ROLE[row.role],
    rawRole: row.rawRole,
    points: row.points,
    deliveredOn: row.deliveredOn,
    title: row.title,
    providerPersonId: row.person.providerPersonId,
    personEmail: row.person.email,
  };
}
