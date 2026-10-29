import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectArtifactViewStateKey } from "../use-project-artifact-view-state-key";

const auth = vi.hoisted(() => ({
  userId: "user-a" as string | null,
  orgId: "org-a" as string | null,
}));
vi.mock("../../../shared/auth/use-auth-snapshot", () => ({
  useOptionalAuthSnapshot: () => auth,
}));

beforeEach(() => {
  auth.userId = "user-a";
  auth.orgId = "org-a";
});

describe("useProjectArtifactViewStateKey", () => {
  it("keeps team/project state separate and uses the shared identity namespace", () => {
    const { result, rerender } = renderHook(
      ({ teamId, projectId }) =>
        useProjectArtifactViewStateKey(teamId, projectId),
      { initialProps: { teamId: "team-a", projectId: "project-a" } }
    );
    const original = result.current;
    expect(original).toBe(
      "table:view:project-artifacts-portable:team-a:project-a::id:user-a:org-a"
    );
    rerender({ teamId: "team-a", projectId: "project-b" });
    expect(result.current).not.toBe(original);
    rerender({ teamId: "team-b", projectId: "project-a" });
    expect(result.current).not.toBe(original);
    auth.userId = "user-b";
    rerender({ teamId: "team-a", projectId: "project-a" });
    expect(result.current).not.toBe(original);
    auth.orgId = "org-b";
    rerender({ teamId: "team-a", projectId: "project-a" });
    expect(result.current).not.toBe(original);
  });

  it("persists nothing until the complete owner identity resolves", () => {
    auth.userId = null;
    const { result, rerender } = renderHook(
      ({ teamId, projectId }) =>
        useProjectArtifactViewStateKey(teamId, projectId),
      { initialProps: { teamId: "team-a", projectId: "project-a" } }
    );
    expect(result.current).toBeNull();
    auth.userId = "user-a";
    auth.orgId = null;
    rerender({ teamId: "team-a", projectId: "project-a" });
    expect(result.current).toBeNull();
    auth.orgId = "org-a";
    rerender({ teamId: "team-a", projectId: "" });
    expect(result.current).toBeNull();
  });
});
