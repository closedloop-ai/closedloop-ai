import type { PrismaClient } from "@repo/database";
import { beforeEach, expect, test, vi } from "vitest";
import { ensureVibeApiKey, VIBE_API_KEY_NAME } from "../vibe-seed/core/api-key";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/app/api-keys/service", () => ({ apiKeysService: { generate } }));

beforeEach(() => vi.clearAllMocks());

test("seeds a missing key through the production producer without exporting plaintext", async () => {
  const findFirst = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: "key" });
  const prisma = { apiKey: { findFirst } } as unknown as PrismaClient;
  const input = { prisma, organizationId: "org", userId: "user" };
  await ensureVibeApiKey(input);
  await ensureVibeApiKey(input);
  expect(generate).toHaveBeenCalledExactlyOnceWith("org", "user", {
    name: VIBE_API_KEY_NAME,
  });
  expect(findFirst).toHaveBeenCalledWith({
    where: {
      organizationId: "org",
      userId: "user",
      name: VIBE_API_KEY_NAME,
      revokedAt: null,
    },
    select: { id: true },
  });
});
