import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";
import { getLatestElectronRelease } from "@repo/github/electron-release";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /electron-release
 * Returns the latest Electron app release info: .dmg download URL, version tag, and release notes.
 */
export const GET = withAnyAuth<ElectronReleaseInfo, "/electron-release">(
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
