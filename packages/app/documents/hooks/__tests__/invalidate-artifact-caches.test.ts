import { projectTreeKeys } from "@repo/app/projects/hooks/use-project-tree";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { documentKeys } from "../document-keys";
import { artifactLinkKeys } from "../use-artifact-links";
import { invalidateArtifactCaches } from "../use-documents";

function seededClient(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(documentKeys.list({ projectId: "p1" }), []);
  queryClient.setQueryData(projectTreeKeys.detail("p1"), {
    nodes: [],
    externalParents: [],
  });
  queryClient.setQueryData(projectTreeKeys.detail("p2"), {
    nodes: [],
    externalParents: [],
  });
  return queryClient;
}

function isInvalidated(
  queryClient: QueryClient,
  queryKey: readonly unknown[]
): boolean {
  return queryClient.getQueryState(queryKey)?.isInvalidated === true;
}

describe("invalidateArtifactCaches", () => {
  it("invalidates document lists and the given project's tree, leaving other trees alone", () => {
    const queryClient = seededClient();

    invalidateArtifactCaches(queryClient, { projectId: "p1" });

    expect(
      isInvalidated(queryClient, documentKeys.list({ projectId: "p1" }))
    ).toBe(true);
    expect(isInvalidated(queryClient, projectTreeKeys.detail("p1"))).toBe(true);
    expect(isInvalidated(queryClient, projectTreeKeys.detail("p2"))).toBe(
      false
    );
  });

  it("invalidates every project tree when no projectId is known (batch mutations)", () => {
    const queryClient = seededClient();

    invalidateArtifactCaches(queryClient, {});

    expect(isInvalidated(queryClient, projectTreeKeys.detail("p1"))).toBe(true);
    expect(isInvalidated(queryClient, projectTreeKeys.detail("p2"))).toBe(true);
    expect(
      isInvalidated(queryClient, documentKeys.list({ projectId: "p1" }))
    ).toBe(true);
  });

  it("invalidates resolved artifact-link views and every tree when artifactId is given", () => {
    const queryClient = seededClient();
    const linkKey = artifactLinkKeys.list({ artifactId: "a1", resolved: true });
    queryClient.setQueryData(linkKey, [{ sourceId: "a1", targetId: "b1" }]);
    const unrelatedLinkKey = artifactLinkKeys.list({
      artifactId: "other",
      resolved: true,
    });
    queryClient.setQueryData(unrelatedLinkKey, [
      { sourceId: "other", targetId: "b2" },
    ]);

    invalidateArtifactCaches(queryClient, { artifactId: "a1" });

    expect(isInvalidated(queryClient, linkKey)).toBe(true);
    expect(isInvalidated(queryClient, unrelatedLinkKey)).toBe(false);
    // Single-artifact mutations invalidate every project tree: the artifact
    // can appear in other projects' trees as a cross-project external parent.
    expect(isInvalidated(queryClient, projectTreeKeys.detail("p1"))).toBe(true);
    expect(isInvalidated(queryClient, projectTreeKeys.detail("p2"))).toBe(true);
  });

  it("prefix-invalidates variant tree queries cached under the project's detail key", () => {
    const queryClient = seededClient();
    const variantKey = [...projectTreeKeys.detail("p1"), "with-details"];
    queryClient.setQueryData(variantKey, {
      nodes: [],
      externalParents: [],
      documents: [],
    });

    invalidateArtifactCaches(queryClient, { projectId: "p1" });

    expect(isInvalidated(queryClient, variantKey)).toBe(true);
  });
});
