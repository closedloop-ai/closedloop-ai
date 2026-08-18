import type { BranchListResponse } from "@repo/api/src/types/branch";
import { ReadSource } from "@repo/api/src/types/read-source";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalBranchDetailResponseFixture,
  canonicalBranchListResponseFixture,
  canonicalBranchProjectionFixture,
  canonicalBranchProjectionVariants,
} from "../../test-fixtures/canonical-branch-projection";
import { createHttpBranchesDataSource } from "../branches-data-source";

describe("canonical Branch projection HTTP parity", () => {
  it("returns every canonical field and typed availability state unchanged", async () => {
    const get = vi.fn();
    const result = await createHttpBranchesDataSource({
      get: <T>() => {
        get();
        return Promise.resolve(canonicalBranchListResponseFixture as T);
      },
    }).list({
      limit: 1,
    });

    expect(get).toHaveBeenCalledOnce();
    expect(result).toEqual(canonicalBranchListResponseFixture);
    expect(result.items[0]?.canonicalProjection).toEqual(
      canonicalBranchProjectionFixture
    );
  });

  it("preserves a legacy row with no canonical projection", async () => {
    const canonicalRow = canonicalBranchListResponseFixture.items[0];
    if (!canonicalRow) {
      throw new Error("canonical fixture must contain one row");
    }
    const { canonicalProjection: _projection, ...legacyRow } = canonicalRow;
    const response: BranchListResponse = {
      items: [legacyRow],
      total: 1,
      viewerScope: canonicalBranchListResponseFixture.viewerScope,
      hasMore: false,
      readSource: ReadSource.Cloud,
    };
    const source = createHttpBranchesDataSource({
      get: <T>() => Promise.resolve(response as T),
    });

    const result = await source.list({ limit: 1 });

    expect(result.items[0]).not.toHaveProperty("canonicalProjection");
  });

  it.each(
    canonicalBranchProjectionVariants
  )("preserves alternate typed projection states through list and detail", async (canonicalProjection) => {
    const listResponse: BranchListResponse = {
      ...canonicalBranchListResponseFixture,
      items: [
        {
          ...canonicalBranchListResponseFixture.items[0]!,
          canonicalProjection,
        },
      ],
    };
    const detailResponse = {
      ...canonicalBranchDetailResponseFixture,
      canonicalProjection,
    };
    const source = createHttpBranchesDataSource({
      get: <T>(path: string) =>
        Promise.resolve(
          (path === "/branches/branch-artifact-1"
            ? detailResponse
            : listResponse) as T
        ),
    });

    const list = await source.list({ limit: 1 });
    const detail = await source.detail("branch-artifact-1");

    expect(list.items[0]?.canonicalProjection).toEqual(canonicalProjection);
    expect(detail.canonicalProjection).toEqual(canonicalProjection);
  });

  it("does not coerce an unknown future projection generation", async () => {
    const futureProjection = { version: "v2", opaque: { retained: true } };
    const response = {
      ...canonicalBranchListResponseFixture,
      items: [
        {
          ...canonicalBranchListResponseFixture.items[0]!,
          canonicalProjection: futureProjection,
        },
      ],
    };
    const source = createHttpBranchesDataSource({
      get: <T>() => resolveExternalPayload<T>(response),
    });

    const result = await source.list({ limit: 1 });

    expect(result.items[0]?.canonicalProjection).toEqual(futureProjection);
  });
});

function resolveExternalPayload<T>(value: unknown): Promise<T> {
  return Promise.resolve(value as T);
}
