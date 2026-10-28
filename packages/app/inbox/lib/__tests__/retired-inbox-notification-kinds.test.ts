import { RetiredInboxNotificationKind } from "@repo/api/src/types/retired-inbox-notification-kinds";
import { describe, expect, it } from "vitest";
import { withoutRetiredInboxNotificationKinds } from "../retired-inbox-notification-kinds";

describe("withoutRetiredInboxNotificationKinds", () => {
  it("drops retired kinds and keeps every other kind in order", () => {
    const records = [
      { id: "a", kind: "$assignment" },
      { id: "b", kind: RetiredInboxNotificationKind.LoopCompleted },
      { id: "c", kind: "thread" },
      { id: "d", kind: "$someFutureKind" },
    ];

    expect(
      withoutRetiredInboxNotificationKinds(records).map((record) => record.id)
    ).toEqual(["a", "c", "d"]);
  });

  it("returns an empty list when only retired kinds are stored", () => {
    expect(
      withoutRetiredInboxNotificationKinds([
        { kind: RetiredInboxNotificationKind.LoopCompleted },
      ])
    ).toEqual([]);
  });
});
