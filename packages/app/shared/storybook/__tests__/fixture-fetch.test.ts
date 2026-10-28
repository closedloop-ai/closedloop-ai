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

  it.each(["/artifacts/favorites", "/custom-fields"])(
    "returns an empty list for the unmatched list read %s",
    async (path) => {
      const response = await createFixtureFetch()(path);

      await expect(response.json()).resolves.toEqual({
        success: true,
        data: [],
      });
    }
  );

  it("keeps unmatched tag reads array-shaped when a story supplies custom routes", async () => {
    const response = await createFixtureFetch([
      { method: "GET", path: "/projects/project-1/tree", respond: () => ({}) },
    ])("/tags");

    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [],
    });
  });
});
