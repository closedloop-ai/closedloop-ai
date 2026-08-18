import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import { describe, expect, it } from "vitest";
import { FeedItemKind } from "../../feed-item";
import { activitySource } from "../../sources/activity-source";
import {
  ACTIVITY_SOURCE_ID,
  type ActivityFeedItem,
  ActivityFilterKind,
  DEFAULT_ACTIVITY_FILTER_STATE,
  isActivityFiltered,
  passesActivityFilter,
} from "../../sources/activity-types";

function makeItem(
  kind: ActivityFeedActorKind,
  id = "event:1"
): ActivityFeedItem {
  const event: ArtifactActivityFeedItem = {
    id,
    source: ActivityFeedItemSource.Event,
    action: ArtifactActivityAction.StatusChange,
    actor: { kind, id: kind === ActivityFeedActorKind.Human ? "u1" : null },
    before: null,
    after: null,
    payload: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  return {
    id,
    kind: FeedItemKind.Activity,
    sourceId: ACTIVITY_SOURCE_ID,
    createdAt: event.createdAt,
    event,
  };
}

describe("activity filter", () => {
  it("passes every item on the All default", () => {
    for (const kind of Object.values(ActivityFeedActorKind)) {
      expect(
        passesActivityFilter(makeItem(kind), DEFAULT_ACTIVITY_FILTER_STATE)
      ).toBe(true);
    }
  });

  it("narrows to the selected actor kind", () => {
    const human = makeItem(ActivityFeedActorKind.Human);
    const agent = makeItem(ActivityFeedActorKind.Agent);
    const state = { actorKind: ActivityFilterKind.Agent };
    expect(passesActivityFilter(human, state)).toBe(false);
    expect(passesActivityFilter(agent, state)).toBe(true);
  });

  it("reports isFiltered only for non-All states", () => {
    expect(isActivityFiltered(DEFAULT_ACTIVITY_FILTER_STATE)).toBe(false);
    expect(isActivityFiltered({ actorKind: ActivityFilterKind.Human })).toBe(
      true
    );
  });
});

describe("activitySource", () => {
  it("has the reserved Activity kind + id", () => {
    expect(activitySource.kind).toBe(FeedItemKind.Activity);
    expect(activitySource.id).toBe(ACTIVITY_SOURCE_ID);
  });

  it("applyFilter returns all items on the default state", () => {
    const items = [
      makeItem(ActivityFeedActorKind.Human, "event:a"),
      makeItem(ActivityFeedActorKind.System, "event:b"),
    ];
    expect(
      activitySource.applyFilter(items, DEFAULT_ACTIVITY_FILTER_STATE)
    ).toHaveLength(2);
  });

  it("applyFilter narrows by actor kind", () => {
    const items = [
      makeItem(ActivityFeedActorKind.Human, "event:a"),
      makeItem(ActivityFeedActorKind.Agent, "event:b"),
    ];
    const result = activitySource.applyFilter(items, {
      actorKind: ActivityFilterKind.Agent,
    });
    expect(result.map((i) => i.id)).toEqual(["event:b"]);
  });

  it("isFiltered mirrors the filter helper", () => {
    expect(activitySource.isFiltered(DEFAULT_ACTIVITY_FILTER_STATE)).toBe(
      false
    );
    expect(
      activitySource.isFiltered({ actorKind: ActivityFilterKind.System })
    ).toBe(true);
  });
});
