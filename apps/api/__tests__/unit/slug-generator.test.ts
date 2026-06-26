import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
}));

import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { generateSlug } from "../../lib/slug-generator";

const ORG_ID = "org-1";

describe("generateSlug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns correct TYPE-NNN format when counter returns currentValue 1", async () => {
    const mockDb = {
      slugCounter: {
        upsert: vi.fn().mockResolvedValue({ currentValue: 1 }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await generateSlug(ORG_ID, SlugPrefix.Project);

    expect(result).toBe("PRO-1");
  });

  it("returns incremented value on sequential calls", async () => {
    const mockDb = {
      slugCounter: {
        upsert: vi
          .fn()
          .mockResolvedValueOnce({ currentValue: 1 })
          .mockResolvedValueOnce({ currentValue: 2 }),
      },
    };
    mockWithDbCall(mockDb);

    const first = await generateSlug(ORG_ID, SlugPrefix.Project);
    const second = await generateSlug(ORG_ID, SlugPrefix.Project);

    expect(first).toBe("PRO-1");
    expect(second).toBe("PRO-2");
  });

  it("uses separate counters per type prefix", async () => {
    const mockDb = {
      slugCounter: {
        upsert: vi
          .fn()
          .mockResolvedValueOnce({ currentValue: 1 })
          .mockResolvedValueOnce({ currentValue: 1 }),
      },
    };
    mockWithDbCall(mockDb);

    await generateSlug(ORG_ID, SlugPrefix.Prd);
    await generateSlug(ORG_ID, SlugPrefix.Plan);

    expect(mockDb.slugCounter.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          organizationId_typePrefix: {
            organizationId: ORG_ID,
            typePrefix: SlugPrefix.Prd,
          },
        },
      })
    );
    expect(mockDb.slugCounter.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          organizationId_typePrefix: {
            organizationId: ORG_ID,
            typePrefix: SlugPrefix.Plan,
          },
        },
      })
    );
  });
});
