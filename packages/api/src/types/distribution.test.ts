import { describe, expect, it } from "vitest";
import { type DistributionDto, toOptInDistributionDto } from "./distribution";

function makeDistribution(
  over: Partial<DistributionDto> = {}
): DistributionDto {
  return {
    id: "dist-1",
    organizationId: "org-1",
    catalogItemId: "cat-1",
    catalogItem: {
      id: "cat-1",
      name: "RTK",
      targetKind: "plugin",
      source: "curated",
      coaching: true,
    },
    mode: "opt_in",
    targetingType: "all",
    desiredEnabled: true,
    targetingEntries: [],
    targetStatuses: [],
    assetDownloadUrl: "https://s3.example.com/asset.zip?X-Amz-Signature=secret",
    createdAt: "2026-07-11T00:00:00Z",
    updatedAt: "2026-07-11T00:00:00Z",
    ...over,
  };
}

describe("toOptInDistributionDto (FEA-3043)", () => {
  it("projects only the renderer-safe fields", () => {
    const projected = toOptInDistributionDto(makeDistribution());

    expect(projected).toEqual({
      id: "dist-1",
      mode: "opt_in",
      catalogItem: {
        id: "cat-1",
        name: "RTK",
        targetKind: "plugin",
        coaching: true,
      },
    });
  });

  it("never exposes the presigned assetDownloadUrl to the renderer", () => {
    const projected = toOptInDistributionDto(makeDistribution());

    expect("assetDownloadUrl" in projected).toBe(false);
    expect(JSON.stringify(projected)).not.toContain("X-Amz-Signature");
  });

  it("drops the catalogItem.source field the banner does not render", () => {
    const projected = toOptInDistributionDto(makeDistribution());

    expect("source" in projected.catalogItem).toBe(false);
  });

  it("carries coaching through undefined when the source omits it", () => {
    const projected = toOptInDistributionDto(
      makeDistribution({
        catalogItem: {
          id: "cat-2",
          name: "Generic Plugin",
          targetKind: "plugin",
          source: "org_custom",
        },
      })
    );

    expect(projected.catalogItem.coaching).toBeUndefined();
  });
});
