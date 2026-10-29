/**
 * The PROVIDER-NEUTRAL delivery record (ISS-8399) — the shape the store accepts.
 *
 * This module is the actual seam. `NumeratorProvider` and
 * `DELIVERY_PROVIDER_BINDINGS` make DECLARING a second provider fail `tsc` until
 * it says what it is; they do nothing to make PERSISTING one possible. A store
 * whose input was `ResolvedDeliveryRow` — Pensero's own row, carrying Pensero's
 * own `item_type` and `role` vocabularies — would force a JIRA adapter to
 * fabricate Pensero rows and classify its work into Pensero's categories before
 * it could write anything. That is a seam in name only.
 *
 * So the boundary is drawn here instead: everything below this line speaks OUR
 * stored vocabulary (`DeliveryItemType`, `DeliveryContributorRole`) and nothing
 * else. A provider adapter's whole job is to produce a
 * {@link NormalizedDeliveryPoint}; the store, the association writer and the
 * stored-index reader never learn which provider it came from beyond the
 * `provider` column.
 *
 * IMPORTANT: this file must not import from `@repo/pensero`. That is the
 * invariant the seam consists of, and `__tests__/delivery-point-record.test.ts`
 * exercises it by building a record for a hypothetical provider without loading
 * any Pensero module.
 */

import type { DeliveryContributorRole, DeliveryItemType } from "@repo/database";

/**
 * One delivery record from any external numerator provider, already translated
 * into the vocabulary we store.
 *
 * The `raw*` pair is retained deliberately: every provider owns its own item and
 * role vocabularies and will add to them, so a value that classified as `OTHER`
 * keeps the verbatim wire string an operator needs in order to see WHAT arrived.
 * Dropping it would make "a kind we do not model" indistinguishable from "a kind
 * the provider does not have".
 */
export type NormalizedDeliveryPoint = {
  /** The provider's own row id. The idempotency key — never a title, never a
   * (person, date) tuple, both of which repeat. */
  readonly providerItemId: string;
  /**
   * The provider's own id for the interaction this record belongs to, or null
   * when the provider models no such thing. It is the key a later run reads back
   * to recover a reference an earlier window established, so a provider with no
   * interaction concept simply never benefits from that carry-forward.
   */
  readonly providerInteractionId: string | null;
  readonly itemType: DeliveryItemType;
  /** Verbatim provider `item_type`, retained even when classified `OTHER`. */
  readonly rawItemType: string;
  readonly role: DeliveryContributorRole;
  /** Verbatim provider `role`, retained even when classified `OTHER`. */
  readonly rawRole: string;
  /**
   * The provider's MEASURED value. `0` is one of its legal measurements and must
   * never be conflated with "unmatched" or "not yet backfilled"; the adapter is
   * responsible for having rejected anything that is not a measurement, and for
   * having rejected a measurement the stored column cannot hold as measured.
   */
  readonly points: number;
  /** The calendar day the provider attributed the delivery to, `YYYY-MM-DD`. */
  readonly deliveredOn: string;
  /** Diagnostic only. Never a matching key, and never a source of associations. */
  readonly title: string;
  readonly providerPersonId: string;
  /** The normalized (lowercased, trimmed) bridge email. */
  readonly personEmail: string;
};
