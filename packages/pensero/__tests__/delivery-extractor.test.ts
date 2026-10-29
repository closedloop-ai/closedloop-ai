/**
 * Extractor hazard suite, driven by the synthetic hazard fixture.
 *
 * The fixture is not a volume sample — every row in it was selected because it
 * demonstrates a named extraction hazard (`_hazards` in the file itself). These
 * tests assert against it by hazard, so a regression names what broke.
 */

import { describe, expect, it } from "vitest";
import {
  PenseroDeliveryItemType,
  PenseroDeliveryRejectionReason,
  PenseroDeliveryRole,
} from "../delivery-contract";
import { extractDeliverySegment } from "../delivery-extractor";
import fixture from "./fixtures/pensero-delivery-hazards.fixture.json";

const segment = extractDeliverySegment(fixture);

function rowById(itemId: string) {
  const row = segment.rows.find((candidate) => candidate.itemId === itemId);
  if (!row) {
    throw new Error(`fixture row ${itemId} not extracted`);
  }
  return row;
}

describe("extractDeliverySegment over the hazard fixture", () => {
  it("extracts every row in the payload and rejects none", () => {
    expect(segment.rows).toHaveLength(39);
    expect(segment.rowsRejected).toEqual([]);
    expect(segment.peopleRejected).toBe(0);
    expect(segment.startDate).toBe("2026-08-01");
    expect(segment.endDate).toBe("2026-08-04");
  });

  it("H12: counts a person with an empty deliveries array as present", () => {
    // `deliveries: []` is a PRESENT person with no rows. Skipping them would
    // make "this person delivered nothing" indistinguishable from "this person
    // was not in the response".
    expect(segment.peopleSeen).toBe(7);
    const emails = new Set(segment.rows.map((row) => row.person.email));
    expect(emails.has("jory.hollingsworth@closedloop.ai")).toBe(false);
  });

  it("H1: a creator row carries no pull-request number of its own", () => {
    const creator = rowById("2656228");
    expect(creator.itemType).toBe(PenseroDeliveryItemType.PullRequest);
    expect(creator.role).toBe(PenseroDeliveryRole.Creator);
    expect(creator.points).toBe(3);
    expect(creator.pullRequest).toBeNull();
    expect(creator.interaction).toEqual({
      kind: "pull_request",
      id: "1539716",
    });
  });

  it("H1: only a review row embeds the number, and it shares the creator's url", () => {
    const review = rowById("2656344");
    expect(review.itemType).toBe(PenseroDeliveryItemType.PullRequestReview);
    expect(review.pullRequest).toEqual({
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      number: 4228,
    });
    expect(review.interaction?.id).toBe(rowById("2656228").interaction?.id);
  });

  it("H8: a measured zero is extracted as zero, not dropped", () => {
    const zeroCreator = rowById("2428735");
    expect(zeroCreator.points).toBe(0);
    // And it is a real row, so it is distinguishable from a PR with no row.
    expect(zeroCreator.itemType).toBe(PenseroDeliveryItemType.PullRequest);
  });

  it("H10: non-PR item types are extracted with their points and no pull request", () => {
    const messaging = rowById("2670502");
    expect(messaging.itemType).toBe(PenseroDeliveryItemType.Messaging);
    expect(messaging.points).toBe(2.75);
    expect(messaging.interaction).toBeNull();
    expect(messaging.pullRequest).toBeNull();

    const ticket = rowById("2685218");
    expect(ticket.itemType).toBe(PenseroDeliveryItemType.Ticket);
    expect(ticket.points).toBe(0.65);
    expect(ticket.interaction).toEqual({ kind: "ticket", id: "2665541" });
    expect(ticket.pullRequest).toBeNull();
  });

  it("H9: one pull request yields a creator row plus reviewer rows to other people", () => {
    const onInteraction = segment.rows.filter(
      (row) => row.interaction?.id === "1539716"
    );
    expect(onInteraction).toHaveLength(3);
    expect(new Set(onInteraction.map((row) => row.role))).toEqual(
      new Set([PenseroDeliveryRole.Creator, PenseroDeliveryRole.Reviewer])
    );
    expect(new Set(onInteraction.map((row) => row.person.email)).size).toBe(2);
  });

  it("H11: the person bridge key is the lowercased email, not the username", () => {
    const row = rowById("2656228");
    expect(row.person.rawUsername).toBe("Daveth.Oakhurst@closedloop.ai");
    expect(row.person.email).toBe("daveth.oakhurst@closedloop.ai");
    expect(row.person.providerPersonId).toBe("2950");
  });

  it("H5: two distinct pull requests may share a byte-identical creator title", () => {
    const shared = segment.rows.filter(
      (row) =>
        row.title ===
          "PLN-1562: share the widget queue mechanics across both sync lanes" &&
        row.itemType === PenseroDeliveryItemType.PullRequest
    );
    expect(shared).toHaveLength(2);
    // Same title, different interactions — which is why the title is never a key.
    expect(new Set(shared.map((row) => row.interaction?.id)).size).toBe(2);
    expect(new Set(shared.map((row) => row.points))).toEqual(new Set([0, 8]));
  });

  it("H13: a window returns rows dated inside it for much older pull requests", () => {
    // Every row's date sits in the requested window even though `2428735`
    // belongs to a PR from a far earlier interaction id — which is why the
    // upsert key is the provider row id and nothing ever sums on re-read.
    for (const row of segment.rows) {
      expect(row.deliveredOn >= segment.startDate).toBe(true);
      expect(row.deliveredOn <= segment.endDate).toBe(true);
    }
  });
});

describe("extractDeliverySegment boundary behaviour", () => {
  const envelope = (deliveries: unknown[]) => ({
    start_date: "2026-08-01",
    end_date: "2026-08-04",
    users: [
      {
        user: {
          id: 1,
          name: "A",
          email: "a@example.com",
          username: "a@example.com",
        },
        deliveries,
      },
    ],
  });

  it("rejects one bad row without taking the segment with it", () => {
    // The lesson a strict boundary schema taught this repo the hard way: one
    // unknown-shaped row must not silently drop the whole payload.
    const result = extractDeliverySegment(
      envelope([
        {
          date: "2026-08-01",
          item_id: "1",
          item_type: "pull_request",
          role: "creator",
          title: "ok",
          url: null,
          delivery: 3,
        },
        { date: "2026-08-01", item_id: "2", item_type: "pull_request" },
      ])
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rowsRejected).toEqual([
      { reason: PenseroDeliveryRejectionReason.MalformedRow, itemId: "2" },
    ]);
  });

  it("rejects a negative value rather than coercing it to a measured zero", () => {
    const result = extractDeliverySegment(
      envelope([
        {
          date: "2026-08-01",
          item_id: "3",
          item_type: "pull_request",
          role: "creator",
          title: "bad",
          url: null,
          delivery: -2,
        },
      ])
    );
    expect(result.rows).toEqual([]);
    expect(result.rowsRejected).toEqual([
      {
        reason: PenseroDeliveryRejectionReason.NonMeasurablePoints,
        itemId: "3",
      },
    ]);
  });

  it("rejects an impossible date", () => {
    const result = extractDeliverySegment(
      envelope([
        {
          date: "2026-02-30",
          item_id: "4",
          item_type: "pull_request",
          role: "creator",
          title: "bad date",
          url: null,
          delivery: 1,
        },
      ])
    );
    expect(result.rowsRejected).toEqual([
      { reason: PenseroDeliveryRejectionReason.MalformedDate, itemId: "4" },
    ]);
  });

  it("rejects every row of a person with no usable email", () => {
    const result = extractDeliverySegment({
      start_date: "2026-08-01",
      end_date: "2026-08-04",
      users: [
        {
          user: { id: 9, name: "No Email", email: "  ", username: "x" },
          deliveries: [
            {
              date: "2026-08-01",
              item_id: "5",
              item_type: "pull_request",
              role: "creator",
              title: "t",
              url: null,
              delivery: 4,
            },
          ],
        },
      ],
    });
    expect(result.rows).toEqual([]);
    expect(result.rowsRejected).toEqual([
      {
        reason: PenseroDeliveryRejectionReason.UnbridgeablePerson,
        itemId: "5",
      },
    ]);
  });

  it("keeps an unrecognized item type with its verbatim wire value", () => {
    const result = extractDeliverySegment(
      envelope([
        {
          date: "2026-08-01",
          item_id: "6",
          item_type: "incident",
          role: "responder",
          title: "t",
          url: null,
          delivery: 2,
        },
      ])
    );
    expect(result.rows[0].itemType).toBe(PenseroDeliveryItemType.Other);
    expect(result.rows[0].rawItemType).toBe("incident");
    expect(result.rows[0].role).toBe(PenseroDeliveryRole.Other);
    expect(result.rows[0].rawRole).toBe("responder");
  });

  it("throws when the envelope is not the delivery feed at all", () => {
    expect(() => extractDeliverySegment({ detail: "Not found" })).toThrow();
  });

  it("counts EVERY row a malformed person hid, not the person as one row", () => {
    // The person envelope fails the schema (no `username`) while carrying three
    // otherwise-valid rows. One rejection per person would report this segment
    // as short by one row when it is short by three, understating the missing
    // population by exactly the rows nobody can see.
    const result = extractDeliverySegment({
      start_date: "2026-08-01",
      end_date: "2026-08-04",
      users: [
        {
          user: { id: 9, name: "No Username", email: "a@b.c" },
          deliveries: [{ item_id: "10" }, { item_id: "11" }, { item_id: "12" }],
        },
      ],
    });
    expect(result.rows).toEqual([]);
    expect(result.peopleRejected).toBe(1);
    expect(result.rowsRejected).toEqual([
      { reason: PenseroDeliveryRejectionReason.MalformedRow, itemId: "10" },
      { reason: PenseroDeliveryRejectionReason.MalformedRow, itemId: "11" },
      { reason: PenseroDeliveryRejectionReason.MalformedRow, itemId: "12" },
    ]);
  });

  it("names a malformed row by a numeric item_id, and by null when it has none", () => {
    const result = extractDeliverySegment(
      envelope([{ item_id: 42 }, 7, null, { item_id: true }])
    );
    expect(result.rows).toEqual([]);
    expect(result.rowsRejected).toEqual([
      { reason: PenseroDeliveryRejectionReason.MalformedRow, itemId: "42" },
      { reason: PenseroDeliveryRejectionReason.MalformedRow, itemId: null },
      { reason: PenseroDeliveryRejectionReason.MalformedRow, itemId: null },
      { reason: PenseroDeliveryRejectionReason.MalformedRow, itemId: null },
    ]);
  });

  it("reports a malformed person that hid no readable rows without inventing one", () => {
    const result = extractDeliverySegment({
      start_date: "2026-08-01",
      end_date: "2026-08-04",
      users: [
        { user: { id: 9 }, deliveries: [] },
        "not an entry at all",
        { user: null, deliveries: "nope" },
        null,
      ],
    });
    // Four malformed people, zero rows demonstrably lost. Pushing a placeholder
    // row rejection for each would report a row count nobody measured.
    expect(result.peopleRejected).toBe(4);
    expect(result.rowsRejected).toEqual([]);
    expect(result.peopleSeen).toBe(0);
  });

  it("reads a pull-request reference only out of a row type that carries one", () => {
    // The same title text on four item types. Only a review row legitimately
    // carries the reference; on a creator, messaging or ticket row it is title
    // text that happens to look like one, and honouring it would hand that row —
    // and, through the interaction index, its whole interaction — an identity
    // nothing established.
    const title =
      "Review pull_request: closedloop-ai/closedloop-ai#4228 with title 'x'";
    const result = extractDeliverySegment(
      envelope(
        ["pull_request_review", "pull_request", "messaging", "ticket"].map(
          (itemType, offset) => ({
            date: "2026-08-01",
            item_id: `30${offset}`,
            item_type: itemType,
            role: "creator",
            title,
            url: null,
            delivery: 1,
          })
        )
      )
    );
    const refByItemId = new Map(
      result.rows.map((row) => [row.itemId, row.pullRequest])
    );
    expect(refByItemId.get("300")).toEqual({
      owner: "closedloop-ai",
      repo: "closedloop-ai",
      number: 4228,
    });
    expect(refByItemId.get("301")).toBeNull();
    expect(refByItemId.get("302")).toBeNull();
    expect(refByItemId.get("303")).toBeNull();
  });

  it("reads the reference for an unrecognized type only on POSITIVE evidence", () => {
    // Both fold to `Other` — that bucket is every unknown spelling, not just a
    // renamed review. `pull_request_review_v2` names a pull-request review and
    // is admitted, so the day the provider renames the type we do not silently
    // stop resolving every review row. `messaging_v2` does not, and admitting it
    // on the strength of `Other` alone would reopen the exact false-identity
    // path the item-type gate closes: its title's reference would enter the
    // interaction index and lend every sibling row a borrowed identity.
    const title =
      "Review pull_request: closedloop-ai/closedloop-ai#4228 with title 'x'";
    const result = extractDeliverySegment(
      envelope(
        ["pull_request_review_v2", "messaging_v2"].map((itemType, offset) => ({
          date: "2026-08-01",
          item_id: `31${offset}`,
          item_type: itemType,
          role: "reviewer",
          title,
          url: null,
          delivery: 1,
        }))
      )
    );
    const byItemId = new Map(result.rows.map((row) => [row.itemId, row]));
    // Both rows are PRESERVED — forward compatibility is about keeping the row,
    // not about trusting its title.
    expect(byItemId.get("310")?.itemType).toBe(PenseroDeliveryItemType.Other);
    expect(byItemId.get("311")?.itemType).toBe(PenseroDeliveryItemType.Other);
    expect(byItemId.get("310")?.pullRequest?.number).toBe(4228);
    expect(byItemId.get("311")?.pullRequest).toBeNull();
  });

  it("rejects a blank item_id rather than upserting two rows under one key", () => {
    // `item_id` IS the idempotency key. A blank one makes two distinct rows
    // collide on the unique index — one silently overwriting the other while
    // both still counted as extracted.
    const result = extractDeliverySegment(
      envelope([
        {
          date: "2026-08-01",
          item_id: "   ",
          item_type: "pull_request",
          role: "creator",
          title: "t",
          url: null,
          delivery: 3,
        },
      ])
    );
    expect(result.rows).toEqual([]);
    expect(result.rowsRejected).toEqual([
      { reason: PenseroDeliveryRejectionReason.BlankItemId, itemId: null },
    ]);
  });

  it("rejects points outside the stored decimal domain at the boundary", () => {
    // Both are measurable and neither is storable AS MEASURED: the first would
    // raise a numeric overflow after every segment was already fetched, and the
    // second would round to a fabricated measured zero.
    const result = extractDeliverySegment(
      envelope([
        {
          date: "2026-08-01",
          item_id: "20",
          item_type: "pull_request",
          role: "creator",
          title: "too large",
          url: null,
          delivery: 100_000_000,
        },
        {
          date: "2026-08-01",
          item_id: "21",
          item_type: "pull_request",
          role: "creator",
          title: "too fine",
          url: null,
          delivery: 0.000_01,
        },
      ])
    );
    expect(result.rows).toEqual([]);
    expect(result.rowsRejected).toEqual([
      {
        reason: PenseroDeliveryRejectionReason.PointsOutOfDomain,
        itemId: "20",
      },
      {
        reason: PenseroDeliveryRejectionReason.PointsOutOfDomain,
        itemId: "21",
      },
    ]);
  });
});
