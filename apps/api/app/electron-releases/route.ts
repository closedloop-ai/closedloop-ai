import type { ElectronReleaseInfo } from "@repo/github";
import { getLatestElectronRelease } from "@repo/github";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /electron-releases
 * Returns the latest Electron app release info: .dmg download URL, version tag, and release notes.
 */
export const GET = withAnyAuth<ElectronReleaseInfo, "/electron-releases">(
  async () => {
    try {
      const release = await getLatestElectronRelease();

      if (!release) {
        return notFoundResponse("Electron release");
      }

      return successResponse(release);
    } catch (error) {
      return errorResponse("Failed to fetch electron release", error);
    }
  }
);
