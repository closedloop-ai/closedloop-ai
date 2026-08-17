import { describe, expect, it } from "vitest";
import { resolveNotificationActorId } from "../shared/notification-actor";

describe("resolveNotificationActorId", () => {
  it("returns the actor id when the payload carries one", () => {
    expect(resolveNotificationActorId("user_abc")).toBe("user_abc");
  });

  it("trims surrounding whitespace so a padded id still resolves", () => {
    expect(resolveNotificationActorId("  user_abc  ")).toBe("user_abc");
  });

  it("returns null when the payload carries no actor at all", () => {
    expect(resolveNotificationActorId(undefined)).toBeNull();
    expect(resolveNotificationActorId(null)).toBeNull();
  });

  it("returns null for a blank id rather than an unresolvable lookup key", () => {
    expect(resolveNotificationActorId("")).toBeNull();
    expect(resolveNotificationActorId("   ")).toBeNull();
  });

  it("returns null for non-string values arriving off the wire", () => {
    // The payload round-trips through Liveblocks as `unknown`, so a number or an
    // object is reachable here even though the producer only ever writes strings.
    expect(resolveNotificationActorId(42)).toBeNull();
    expect(resolveNotificationActorId({ id: "user_abc" })).toBeNull();
    expect(resolveNotificationActorId(["user_abc"])).toBeNull();
  });
});
