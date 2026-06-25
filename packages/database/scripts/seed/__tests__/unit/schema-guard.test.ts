import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../../generated/client";
import { assertEffectiveSchema } from "../../schema-guard";
import { SeedSetupFailureMarker } from "../../setup-failure";

function makePrisma(currentSchema: string | null) {
  const $queryRaw = vi
    .fn()
    .mockResolvedValue([{ current_schema: currentSchema }]);
  return { prisma: { $queryRaw } as unknown as PrismaClient, $queryRaw };
}

describe("assertEffectiveSchema", () => {
  it("is a no-op (no DB probe) when no schema is targeted", async () => {
    const { prisma, $queryRaw } = makePrisma("public");
    await expect(assertEffectiveSchema(prisma, null)).resolves.toBeUndefined();
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("is a no-op (no DB probe) when the target schema is public", async () => {
    const { prisma, $queryRaw } = makePrisma("public");
    await expect(
      assertEffectiveSchema(prisma, "public")
    ).resolves.toBeUndefined();
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("resolves when the effective schema matches the target preview schema", async () => {
    const { prisma } = makePrisma("preview_abc");
    await expect(
      assertEffectiveSchema(prisma, "preview_abc")
    ).resolves.toBeUndefined();
  });

  it("throws a schema-guard failure when the connection resolves to public instead of the preview schema", async () => {
    const { prisma } = makePrisma("public");
    await expect(assertEffectiveSchema(prisma, "preview_abc")).rejects.toThrow(
      SeedSetupFailureMarker.SchemaGuard
    );
  });

  it("throws when current_schema() is null", async () => {
    const { prisma } = makePrisma(null);
    await expect(assertEffectiveSchema(prisma, "preview_abc")).rejects.toThrow(
      SeedSetupFailureMarker.SchemaGuard
    );
  });
});
