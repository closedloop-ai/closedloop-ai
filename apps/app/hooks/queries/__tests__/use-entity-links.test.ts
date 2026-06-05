import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { describe, expect, test } from "vitest";
import {
  entityLinkKeys,
  invalidateEntityLinkQueries,
} from "../use-entity-links";
import { createTestQueryClient } from "./test-utils";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function buildLinkedEntity(
  overrides: Partial<LinkedEntity> = {}
): LinkedEntity {
  return {
    id: "link-1",
    organizationId: "org-1",
    sourceId: "feature-1",
    sourceType: EntityType.Feature,
    sourceVersion: null,
    targetId: "artifact-1",
    targetType: EntityType.Artifact,
    targetVersion: null,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date(),
    resolvedEntity: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a resolved-entity-link query and return the QueryClient. */
function seedResolvedQuery(
  filters: Record<string, unknown>,
  data: LinkedEntity[]
) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(entityLinkKeys.list(filters), data);
  return queryClient;
}

/** Check whether a specific query is stale (i.e. was invalidated). */
function isQueryStale(
  queryClient: ReturnType<typeof createTestQueryClient>,
  filters: Record<string, unknown>
) {
  const state = queryClient.getQueryState(entityLinkKeys.list(filters));
  return state?.isInvalidated ?? false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("invalidateEntityLinkQueries", () => {
  test("invalidates query whose cached data contains entity as source", () => {
    const filters = {
      entityId: "feature-1",
      entityType: EntityType.Feature,
      direction: "both",
      resolved: true,
    };
    const data = [
      buildLinkedEntity({
        sourceId: "feature-1",
        sourceType: EntityType.Feature,
        targetId: "artifact-1",
        targetType: EntityType.Artifact,
      }),
    ];

    const queryClient = seedResolvedQuery(filters, data);

    invalidateEntityLinkQueries(queryClient, "feature-1", EntityType.Feature);

    expect(isQueryStale(queryClient, filters)).toBe(true);
  });

  test("invalidates query whose cached data contains entity as target", () => {
    const filters = {
      entityId: "feature-1",
      entityType: EntityType.Feature,
      direction: "both",
      resolved: true,
    };
    const data = [
      buildLinkedEntity({
        sourceId: "feature-1",
        sourceType: EntityType.Feature,
        targetId: "artifact-99",
        targetType: EntityType.Artifact,
      }),
    ];

    const queryClient = seedResolvedQuery(filters, data);

    invalidateEntityLinkQueries(
      queryClient,
      "artifact-99",
      EntityType.Artifact
    );

    expect(isQueryStale(queryClient, filters)).toBe(true);
  });

  test("does not invalidate query when entity is not in cached data", () => {
    const filters = {
      entityId: "feature-1",
      entityType: EntityType.Feature,
      direction: "both",
      resolved: true,
    };
    const data = [
      buildLinkedEntity({
        sourceId: "feature-1",
        sourceType: EntityType.Feature,
        targetId: "artifact-1",
        targetType: EntityType.Artifact,
      }),
    ];

    const queryClient = seedResolvedQuery(filters, data);

    invalidateEntityLinkQueries(
      queryClient,
      "unrelated-entity",
      EntityType.Feature
    );

    expect(isQueryStale(queryClient, filters)).toBe(false);
  });

  test("does not invalidate query with matching id but wrong entity type", () => {
    const filters = {
      entityId: "feature-1",
      entityType: EntityType.Feature,
      direction: "both",
      resolved: true,
    };
    const data = [
      buildLinkedEntity({
        sourceId: "feature-1",
        sourceType: EntityType.Feature,
        targetId: "artifact-1",
        targetType: EntityType.Artifact,
      }),
    ];

    const queryClient = seedResolvedQuery(filters, data);

    // Same id "feature-1" but wrong type — should NOT match
    invalidateEntityLinkQueries(
      queryClient,
      "feature-1",
      EntityType.ExternalLink
    );

    expect(isQueryStale(queryClient, filters)).toBe(false);
  });

  test("skips non-resolved queries (no resolved flag in filters)", () => {
    const resolvedFilters = {
      entityId: "feature-1",
      entityType: EntityType.Feature,
      direction: "both",
      resolved: true,
    };
    const nonResolvedFilters = {
      entityId: "feature-1",
      entityType: EntityType.Feature,
      direction: "both",
    };
    const data = [
      buildLinkedEntity({
        sourceId: "feature-1",
        sourceType: EntityType.Feature,
        targetId: "artifact-1",
        targetType: EntityType.Artifact,
      }),
    ];

    const queryClient = createTestQueryClient();
    queryClient.setQueryData(entityLinkKeys.list(resolvedFilters), data);
    // Seed a non-resolved query with same data shape
    queryClient.setQueryData(entityLinkKeys.list(nonResolvedFilters), data);

    invalidateEntityLinkQueries(queryClient, "feature-1", EntityType.Feature);

    expect(isQueryStale(queryClient, resolvedFilters)).toBe(true);
    expect(isQueryStale(queryClient, nonResolvedFilters)).toBe(false);
  });

  test("skips queries with no cached data", () => {
    const queryClient = createTestQueryClient();
    // No data seeded — query cache is empty

    // Should not throw
    invalidateEntityLinkQueries(queryClient, "feature-1", EntityType.Feature);

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  test("invalidates multiple queries that reference the same entity", () => {
    const filtersA = {
      entityId: "feature-1",
      entityType: EntityType.Feature,
      direction: "both",
      resolved: true,
    };
    const filtersB = {
      entityId: "feature-2",
      entityType: EntityType.Feature,
      direction: "both",
      resolved: true,
    };
    const filtersC = {
      entityId: "feature-3",
      entityType: EntityType.Feature,
      direction: "both",
      resolved: true,
    };

    const sharedArtifact = buildLinkedEntity({
      sourceId: "feature-1",
      sourceType: EntityType.Feature,
      targetId: "artifact-shared",
      targetType: EntityType.Artifact,
    });
    const unrelatedLink = buildLinkedEntity({
      sourceId: "feature-3",
      sourceType: EntityType.Feature,
      targetId: "artifact-other",
      targetType: EntityType.Artifact,
    });

    const queryClient = createTestQueryClient();
    queryClient.setQueryData(entityLinkKeys.list(filtersA), [sharedArtifact]);
    queryClient.setQueryData(entityLinkKeys.list(filtersB), [
      buildLinkedEntity({
        sourceId: "feature-2",
        sourceType: EntityType.Feature,
        targetId: "artifact-shared",
        targetType: EntityType.Artifact,
      }),
    ]);
    queryClient.setQueryData(entityLinkKeys.list(filtersC), [unrelatedLink]);

    invalidateEntityLinkQueries(
      queryClient,
      "artifact-shared",
      EntityType.Artifact
    );

    expect(isQueryStale(queryClient, filtersA)).toBe(true);
    expect(isQueryStale(queryClient, filtersB)).toBe(true);
    expect(isQueryStale(queryClient, filtersC)).toBe(false);
  });
});
