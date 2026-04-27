import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { describe, expect, test } from "vitest";
import {
  artifactLinkKeys,
  invalidateArtifactLinkQueries,
} from "../use-artifact-links";
import { createTestQueryClient } from "./test-utils";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function buildEndpoint(
  overrides: Partial<ArtifactLinkEndpoint> = {}
): ArtifactLinkEndpoint {
  return {
    id: "artifact-1",
    organizationId: "org-1",
    projectId: "project-1",
    workstreamId: null,
    status: "ACTIVE",
    priority: null,
    assigneeId: null,
    createdById: "user-1",
    updatedAt: new Date("2024-01-01"),
    type: ArtifactType.Document,
    subtype: null,
    name: "Artifact 1",
    slug: "artifact-1",
    externalUrl: null,
    dueDate: null,
    sortOrder: null,
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function buildResolvedLink(
  overrides: Partial<ArtifactLinkWithEndpoints> = {}
): ArtifactLinkWithEndpoints {
  const sourceId = overrides.sourceId ?? "feature-1";
  const targetId = overrides.targetId ?? "artifact-1";
  return {
    id: "link-1",
    organizationId: "org-1",
    sourceId,
    targetId,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date(),
    source: buildEndpoint({ id: sourceId, name: sourceId }),
    target: buildEndpoint({ id: targetId, name: targetId }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a resolved-artifact-link query and return the QueryClient. */
function seedResolvedQuery(
  filters: Record<string, unknown>,
  data: ArtifactLinkWithEndpoints[]
) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(artifactLinkKeys.list(filters), data);
  return queryClient;
}

/** Check whether a specific query is stale (i.e. was invalidated). */
function isQueryStale(
  queryClient: ReturnType<typeof createTestQueryClient>,
  filters: Record<string, unknown>
) {
  const state = queryClient.getQueryState(artifactLinkKeys.list(filters));
  return state?.isInvalidated ?? false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("invalidateArtifactLinkQueries", () => {
  test("invalidates query whose cached data contains artifact as source", () => {
    const filters = {
      artifactId: "feature-1",
      direction: "both",
      resolved: true,
    };
    const data = [
      buildResolvedLink({ sourceId: "feature-1", targetId: "artifact-1" }),
    ];

    const queryClient = seedResolvedQuery(filters, data);

    invalidateArtifactLinkQueries(queryClient, "feature-1");

    expect(isQueryStale(queryClient, filters)).toBe(true);
  });

  test("invalidates query whose cached data contains artifact as target", () => {
    const filters = {
      artifactId: "feature-1",
      direction: "both",
      resolved: true,
    };
    const data = [
      buildResolvedLink({ sourceId: "feature-1", targetId: "artifact-99" }),
    ];

    const queryClient = seedResolvedQuery(filters, data);

    invalidateArtifactLinkQueries(queryClient, "artifact-99");

    expect(isQueryStale(queryClient, filters)).toBe(true);
  });

  test("does not invalidate query when artifact is not in cached data", () => {
    const filters = {
      artifactId: "feature-1",
      direction: "both",
      resolved: true,
    };
    const data = [
      buildResolvedLink({ sourceId: "feature-1", targetId: "artifact-1" }),
    ];

    const queryClient = seedResolvedQuery(filters, data);

    invalidateArtifactLinkQueries(queryClient, "unrelated-artifact");

    expect(isQueryStale(queryClient, filters)).toBe(false);
  });

  test("skips non-resolved queries (no resolved flag in filters)", () => {
    const resolvedFilters = {
      artifactId: "feature-1",
      direction: "both",
      resolved: true,
    };
    const nonResolvedFilters = {
      artifactId: "feature-1",
      direction: "both",
    };
    const data = [
      buildResolvedLink({ sourceId: "feature-1", targetId: "artifact-1" }),
    ];

    const queryClient = createTestQueryClient();
    queryClient.setQueryData(artifactLinkKeys.list(resolvedFilters), data);
    queryClient.setQueryData(artifactLinkKeys.list(nonResolvedFilters), data);

    invalidateArtifactLinkQueries(queryClient, "feature-1");

    expect(isQueryStale(queryClient, resolvedFilters)).toBe(true);
    expect(isQueryStale(queryClient, nonResolvedFilters)).toBe(false);
  });

  test("skips queries with no cached data", () => {
    const queryClient = createTestQueryClient();
    // No data seeded — query cache is empty

    // Should not throw
    invalidateArtifactLinkQueries(queryClient, "feature-1");

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  test("invalidates multiple queries that reference the same artifact", () => {
    const filtersA = {
      artifactId: "feature-1",
      direction: "both",
      resolved: true,
    };
    const filtersB = {
      artifactId: "feature-2",
      direction: "both",
      resolved: true,
    };
    const filtersC = {
      artifactId: "feature-3",
      direction: "both",
      resolved: true,
    };

    const sharedArtifact = buildResolvedLink({
      sourceId: "feature-1",
      targetId: "artifact-shared",
    });
    const unrelatedLink = buildResolvedLink({
      sourceId: "feature-3",
      targetId: "artifact-other",
    });

    const queryClient = createTestQueryClient();
    queryClient.setQueryData(artifactLinkKeys.list(filtersA), [sharedArtifact]);
    queryClient.setQueryData(artifactLinkKeys.list(filtersB), [
      buildResolvedLink({
        sourceId: "feature-2",
        targetId: "artifact-shared",
      }),
    ]);
    queryClient.setQueryData(artifactLinkKeys.list(filtersC), [unrelatedLink]);

    invalidateArtifactLinkQueries(queryClient, "artifact-shared");

    expect(isQueryStale(queryClient, filtersA)).toBe(true);
    expect(isQueryStale(queryClient, filtersB)).toBe(true);
    expect(isQueryStale(queryClient, filtersC)).toBe(false);
  });
});
