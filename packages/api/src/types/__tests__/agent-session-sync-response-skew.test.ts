import { describe, expect, it } from "vitest";
import { desktopAgentSessionsSyncResponseValidator } from "../agent-session";

describe("desktopAgentSessionsSyncResponseValidator response skew", () => {
  it("declares exactly the current response keys", () => {
    expect(
      Object.keys(desktopAgentSessionsSyncResponseValidator.shape).sort()
    ).toEqual(["acceptedSessionIds", "synced"]);
  });

  it.each([
    ["the legacy whole-batch response", { synced: true }],
    [
      "the request-gated accepted-session response",
      { synced: true, acceptedSessionIds: ["session-1", "session-2"] },
    ],
  ])("accepts %s", (_label, response) => {
    expect(desktopAgentSessionsSyncResponseValidator.parse(response)).toEqual(
      response
    );
  });

  it("rejects an unknown response key instead of accepting newer-server skew", () => {
    const parsed = desktopAgentSessionsSyncResponseValidator.safeParse({
      synced: true,
      futureResponseKey: "newer-server-only",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual([
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: ["futureResponseKey"],
        }),
      ]);
    }
  });
});
