/**
 * The Pensero delivery-feed EXTRACTOR (ISS-8399): an untrusted JSON response
 * in, a typed {@link PenseroDeliverySegment} out.
 *
 * Validation is Zod at the boundary, never hand-rolled `typeof` checks — the
 * response is an external shape we do not control. But it is deliberately
 * validated at TWO granularities:
 *
 * - The ENVELOPE (`start_date`, `end_date`, `users`) is parsed as a whole, and
 *   a malformed envelope throws. There is nothing to salvage from a response
 *   that is not the delivery feed.
 * - Each PERSON and each ROW is parsed INDIVIDUALLY, and a failure rejects only
 *   that row. A single unrecognized row must not take the segment with it: this
 *   repo has already been bitten by a strict boundary schema silently dropping
 *   a whole payload because one newly-emitted field was unknown to it.
 *
 * Rejections are counted and returned, never swallowed — a segment that is
 * short by four rows says so, and the caller decides what that means for
 * coverage rather than reading a quiet undercount as a measurement.
 */

import { z } from "zod";
import {
  type PenseroDeliveryPerson,
  type PenseroDeliveryRejection,
  PenseroDeliveryRejectionReason,
  type PenseroDeliveryRow,
  type PenseroDeliverySegment,
} from "./delivery-contract";
import {
  classifyDeliveryItemType,
  classifyDeliveryRole,
  isMeasurablePoints,
  isStorablePoints,
  mayCarryPullRequestReference,
  normalizePersonEmail,
  parseCalendarDate,
  parseInteractionUrl,
  parseReviewPullRequestRef,
} from "./delivery-parse";

/**
 * The person envelope. Note what is NOT here: any GitHub login. `username` is
 * email-shaped and is retained verbatim for diagnosis, but `email` is the only
 * bridge key (see `normalizePersonEmail`).
 *
 * Unknown keys are STRIPPED rather than rejected, so a provider-side additive
 * field degrades gracefully instead of failing every person in the response.
 */
const personSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  email: z.string(),
  username: z.string(),
});

/** One delivery row, as it appears on the wire (snake_case). */
const deliveryRowSchema = z.object({
  date: z.string(),
  item_id: z.union([z.number(), z.string()]),
  item_type: z.string(),
  role: z.string(),
  title: z.string(),
  url: z.string().nullable().optional(),
  delivery: z.number(),
});

/**
 * The response envelope. `deliveries: []` is a PRESENT person with no rows —
 * a real state in the payload, and not the same as a person being absent — so
 * the array is required rather than defaulted.
 */
const deliveryResponseSchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
  users: z.array(z.unknown()),
});

const personEntrySchema = z.object({
  user: personSchema,
  deliveries: z.array(z.unknown()),
});

/** Coerce the wire's numeric-or-string ids to the string form we persist. */
function toIdString(value: number | string): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * Build the person bridge, or `null` when there is no usable email. A person
 * with no email cannot be bridged to one of our users at all, so their rows are
 * rejected explicitly rather than attributed to nobody.
 */
function toPerson(
  raw: z.infer<typeof personSchema>
): PenseroDeliveryPerson | null {
  const email = normalizePersonEmail(raw.email);
  if (!email) {
    return null;
  }
  return {
    providerPersonId: toIdString(raw.id),
    name: raw.name,
    email,
    rawEmail: raw.email,
    rawUsername: raw.username,
  };
}

/**
 * Turn one raw row into a typed row, or name why it cannot be one.
 *
 * The PR reference is read ONLY from this row's own title, and only a review
 * row's title carries one. A creator row legitimately produces `pullRequest:
 * null` here and is resolved later through the interaction join — that absence
 * is a stage in the pipeline, not a failure.
 */
function toRow(
  raw: unknown,
  person: PenseroDeliveryPerson
): { row: PenseroDeliveryRow } | { rejection: PenseroDeliveryRejection } {
  const parsed = deliveryRowSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      rejection: {
        reason: PenseroDeliveryRejectionReason.MalformedRow,
        itemId: readItemId(raw),
      },
    };
  }
  const wire = parsed.data;
  const itemId = toIdString(wire.item_id);
  if (itemId.trim().length === 0) {
    return {
      rejection: {
        reason: PenseroDeliveryRejectionReason.BlankItemId,
        itemId: null,
      },
    };
  }
  if (!isMeasurablePoints(wire.delivery)) {
    return {
      rejection: {
        reason: PenseroDeliveryRejectionReason.NonMeasurablePoints,
        itemId,
      },
    };
  }
  if (!isStorablePoints(wire.delivery)) {
    return {
      rejection: {
        reason: PenseroDeliveryRejectionReason.PointsOutOfDomain,
        itemId,
      },
    };
  }
  const deliveredOn = parseCalendarDate(wire.date);
  if (!deliveredOn) {
    return {
      rejection: {
        reason: PenseroDeliveryRejectionReason.MalformedDate,
        itemId,
      },
    };
  }
  const itemType = classifyDeliveryItemType(wire.item_type);
  return {
    row: {
      itemId,
      itemType,
      rawItemType: wire.item_type,
      role: classifyDeliveryRole(wire.role),
      rawRole: wire.role,
      points: wire.delivery,
      deliveredOn,
      title: wire.title,
      interaction: parseInteractionUrl(wire.url),
      // Gated on the item type, and on POSITIVE evidence for a type we do not
      // recognize: only a review row's title legitimately carries the
      // reference, so a creator, messaging or unclassified title that happens
      // to contain the template text cannot hand this row — or, through the
      // interaction index, its whole interaction — an identity it never
      // established.
      pullRequest: mayCarryPullRequestReference(itemType, wire.item_type)
        ? parseReviewPullRequestRef(wire.title)
        : null,
      person,
    },
  };
}

/**
 * Best-effort read of `item_id` from a row that failed the schema, so a
 * rejection can name which row it was. Returns `null` when even that is absent.
 */
function readItemId(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const value = (raw as Record<string, unknown>).item_id;
  if (typeof value === "string" || typeof value === "number") {
    return toIdString(value);
  }
  return null;
}

/**
 * Extract one segment of the delivery feed from a raw JSON response.
 *
 * Throws only when the ENVELOPE is not the delivery feed. Everything narrower —
 * an unparseable person, a row with a negative value, a malformed date — is
 * reported through `rowsRejected` so the caller can see exactly how short of
 * complete the segment is.
 */
export function extractDeliverySegment(json: unknown): PenseroDeliverySegment {
  const envelope = deliveryResponseSchema.parse(json);
  const rows: PenseroDeliveryRow[] = [];
  const rowsRejected: PenseroDeliveryRejection[] = [];
  let peopleSeen = 0;
  let peopleRejected = 0;

  for (const rawEntry of envelope.users) {
    const entry = personEntrySchema.safeParse(rawEntry);
    if (!entry.success) {
      peopleRejected += 1;
      // A malformed person HIDES its rows, and how many it hid is the number
      // that matters for coverage: one rejection per person would report a
      // ten-row person as a single missing row. The array is read off the RAW
      // entry because the parse that would have exposed it is what failed.
      for (const rawRow of readRawDeliveries(rawEntry)) {
        rowsRejected.push({
          reason: PenseroDeliveryRejectionReason.MalformedRow,
          itemId: readItemId(rawRow),
        });
      }
      continue;
    }
    peopleSeen += 1;
    const person = toPerson(entry.data.user);
    if (!person) {
      for (const rawRow of entry.data.deliveries) {
        rowsRejected.push({
          reason: PenseroDeliveryRejectionReason.UnbridgeablePerson,
          itemId: readItemId(rawRow),
        });
      }
      continue;
    }
    for (const rawRow of entry.data.deliveries) {
      const result = toRow(rawRow, person);
      if ("row" in result) {
        rows.push(result.row);
      } else {
        rowsRejected.push(result.rejection);
      }
    }
  }

  return {
    startDate: envelope.start_date,
    endDate: envelope.end_date,
    rows,
    rowsRejected,
    peopleSeen,
    peopleRejected,
  };
}

/**
 * Best-effort read of a rejected person's `deliveries` array, so the rows it
 * took down with it can be counted individually.
 *
 * An entry with no readable array yields NOTHING rather than a placeholder
 * rejection: how many rows it hid is genuinely unknown, and inventing one would
 * report a number nobody measured. `peopleRejected` is what carries that fact.
 */
function readRawDeliveries(raw: unknown): unknown[] {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  const value = (raw as Record<string, unknown>).deliveries;
  return Array.isArray(value) ? value : [];
}
