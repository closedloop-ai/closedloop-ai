import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import { CommentSurface } from "@repo/api/src/types/comment";
import { describe, expect, it } from "vitest";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "../activity-timeline";
import {
  type ArtifactCommentAddress,
  toArtifactActivityRows,
} from "../artifact-activity-rows";

/**
 * ISS-11004 / ISS-10980: the read API projects comments beside every other
 * source, so this module maps one feed page onto rows, for every artifact that
 * mounts an Activity tab. The API owns the order and the paging;
 * what is tested here is which ROW KIND each item becomes and where a comment
 * row points.
 *
 * An earlier revision merged a separately-read comment collection and clamped
 * it to the loaded activity window. Those cases are gone with the clamp: the
 * server pages comments now, so there is no client-side window to clamp and no
 * such contract left to pin.
 */
const href = ({ surface, threadId }: ArtifactCommentAddress) =>
  `/sessions/s-1?tab=${surface ?? "none"}&comment=${threadId}`;

function event(id: string, iso: string): ArtifactActivityFeedItem {
  return {
    action: "updated",
    actor: { id: "u-1", kind: ActivityFeedActorKind.Human },
    after: null,
    before: null,
    createdAt: new Date(iso),
    id: `event:${id}`,
    payload: null,
    source: ActivityFeedItemSource.Event,
  };
}

function comment(
  id: string,
  iso: string,
  payload: ArtifactActivityFeedItem["payload"] = { threadId: id }
): ArtifactActivityFeedItem {
  return {
    action: null,
    actor: { id: "u-2", kind: ActivityFeedActorKind.Human },
    after: null,
    before: null,
    createdAt: new Date(iso),
    id: `comment:${id}`,
    payload,
    source: ActivityFeedItemSource.Comment,
  };
}

function kinds(rows: readonly ActivityTimelineRow[]): string[] {
  return rows.map((row) => row.kind);
}

describe("toArtifactActivityRows", () => {
  it("keeps the API's order and maps each source to its row kind", () => {
    const rows = toArtifactActivityRows({
      buildCommentHref: href,
      events: [
        comment("c-1", "2026-10-03T00:00:00.000Z"),
        event("e-1", "2026-10-02T00:00:00.000Z"),
      ],
    });

    expect(kinds(rows)).toEqual([
      ActivityTimelineRowKind.Comment,
      ActivityTimelineRowKind.Activity,
    ]);
  });

  it("points a comment row at the thread the payload names", () => {
    const rows = toArtifactActivityRows({
      buildCommentHref: href,
      events: [comment("c-9", "2026-10-02T00:00:00.000Z")],
    });

    expect(rows).toEqual([
      {
        authorId: "u-2",
        createdAt: new Date("2026-10-02T00:00:00.000Z"),
        href: "/sessions/s-1?tab=none&comment=c-9",
        id: "comment:c-9",
        kind: ActivityTimelineRowKind.Comment,
      },
    ]);
  });

  /**
   * The payload crosses the wire, so a comment whose `threadId` is missing or
   * not a string has no link to offer. It still happened, so it stays in the
   * stream as an activity card rather than vanishing from the reader's history.
   */
  it.each([
    ["a missing payload", null],
    ["a payload with no threadId", { status: "OPEN" }],
    ["a non-string threadId", { threadId: 7 }],
    ["an empty threadId", { threadId: "" }],
  ])("keeps a comment with %s as an activity row", (_label, payload) => {
    const rows = toArtifactActivityRows({
      buildCommentHref: href,
      events: [comment("c-1", "2026-10-02T00:00:00.000Z", payload)],
    });

    expect(kinds(rows)).toEqual([ActivityTimelineRowKind.Activity]);
  });

  it("carries an unattributed comment without inventing an author", () => {
    const unattributed: ArtifactActivityFeedItem = {
      ...comment("c-1", "2026-10-02T00:00:00.000Z"),
      actor: { id: null, kind: ActivityFeedActorKind.Human },
    };

    const rows = toArtifactActivityRows({
      buildCommentHref: href,
      events: [unattributed],
    });

    const row = rows[0];
    expect(row?.kind).toBe(ActivityTimelineRowKind.Comment);
    expect(row?.kind === ActivityTimelineRowKind.Comment && row.authorId).toBe(
      ""
    );
  });

  it("maps an empty page to no rows", () => {
    expect(
      toArtifactActivityRows({ buildCommentHref: href, events: [] })
    ).toEqual([]);
  });

  /**
   * ISS-10980: the host decides which tab a comment row addresses from the
   * thread's surface, so the mapper must hand it over rather than drop it.
   */
  it("hands the host the surface the feed stated", () => {
    const rows = toArtifactActivityRows({
      buildCommentHref: href,
      events: [
        comment("c-1", "2026-10-02T00:00:00.000Z", {
          surface: CommentSurface.BranchTimeline,
          threadId: "c-1",
        }),
      ],
    });

    const row = rows[0];
    expect(row?.kind === ActivityTimelineRowKind.Comment && row.href).toBe(
      `/sessions/s-1?tab=${CommentSurface.BranchTimeline}&comment=c-1`
    );
  });

  /**
   * The payload crosses the wire, so an absent surface and one a newer server
   * knows and this client does not are both "we cannot say" — never coerced
   * into a surface this client happens to have.
   */
  it.each([
    ["no surface key", { threadId: "c-1" }],
    ["an unknown surface", { surface: "branch_future", threadId: "c-1" }],
    ["a non-string surface", { surface: 7, threadId: "c-1" }],
  ])("states no surface for %s", (_label, payload) => {
    const rows = toArtifactActivityRows({
      buildCommentHref: href,
      events: [comment("c-1", "2026-10-02T00:00:00.000Z", payload)],
    });

    const row = rows[0];
    expect(row?.kind === ActivityTimelineRowKind.Comment && row.href).toBe(
      "/sessions/s-1?tab=none&comment=c-1"
    );
  });
});
