import { describe, expect, it } from "vitest";
import { createFixtureFetch } from "../fixture-fetch";

describe("createFixtureFetch", () => {
  it("returns an empty list for unmatched trace-comment list routes", async () => {
    const response = await createFixtureFetch()(
      "/agent-sessions/session-detail-1/trace-comments"
    );

    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [],
    });
  });
});
