import { describe, expect, test } from "vitest";
import { buildArtifactListParams } from "../utils";

describe("buildArtifactListParams", () => {
  test("returns assigneeId without a type filter", () => {
    const params = buildArtifactListParams("user-123");
    expect(params).toEqual({ assigneeId: "user-123" });
    expect(params).not.toHaveProperty("type");
  });

  test("returns undefined assigneeId when input is null", () => {
    const params = buildArtifactListParams(null);
    expect(params).toEqual({ assigneeId: undefined });
    expect(params).not.toHaveProperty("type");
  });
});
