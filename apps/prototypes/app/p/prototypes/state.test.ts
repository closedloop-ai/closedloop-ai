import { describe, expect, it } from "vitest";
import { initialAnnotations } from "./mock";
import { getOpenCommentCount, toggleResolvedAnnotation } from "./state";

describe("prototype comment state", () => {
  it("resolves and reopens a thread without dropping other comments", () => {
    const resolved = toggleResolvedAnnotation(initialAnnotations, 1);
    expect(resolved).toHaveLength(initialAnnotations.length);
    expect(resolved.find((annotation) => annotation.id === 1)?.resolved).toBe(
      true
    );

    const reopened = toggleResolvedAnnotation(resolved, 1);
    expect(reopened.find((annotation) => annotation.id === 1)?.resolved).toBe(
      false
    );
  });

  it("counts only unresolved comments", () => {
    const resolved = toggleResolvedAnnotation(initialAnnotations, 1);
    expect(getOpenCommentCount(resolved)).toBe(initialAnnotations.length - 1);
  });
});
