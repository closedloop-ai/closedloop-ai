import type { PrismaClient } from "@repo/database";
import { apiKeysService } from "@/app/api-keys/service";
import type { PerfImportCredentials } from "../../perf-import-desktop-snapshot";
import { writeCredentialsFile } from "../../perf-import-desktop-snapshot-guards";

/** Name the minted key carries in the org's API-keys list. */
export const VIBE_API_KEY_NAME = "Local tooling";

/**
 * ISS-12017: mint one API key through the production `apiKeysService` and hand
 * its plaintext to tooling in an owner-only (0600) file, the perf lane's
 * credentials shape. The plaintext is never logged; only the path is.
 */
export async function mintVibeApiKey(input: {
  organizationId: string;
  userId: string;
  outPath: string;
}): Promise<string> {
  const apiKey = await apiKeysService.generate(
    input.organizationId,
    input.userId,
    { name: VIBE_API_KEY_NAME }
  );
  const credentials: PerfImportCredentials = {
    apiBearer: apiKey.plaintext,
    organizationId: input.organizationId,
    userId: input.userId,
  };
  return writeCredentialsFile(input.outPath, credentials);
}

/** Populate the API-key settings view when tooling needs no plaintext file. */
export async function ensureVibeApiKey(input: {
  prisma: PrismaClient;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const existing = await input.prisma.apiKey.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      name: VIBE_API_KEY_NAME,
      revokedAt: null,
    },
    select: { id: true },
  });
  if (existing === null) {
    await apiKeysService.generate(input.organizationId, input.userId, {
      name: VIBE_API_KEY_NAME,
    });
  }
}
