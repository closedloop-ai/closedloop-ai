import type { Loop } from "@repo/api/src/types/loop";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "../service";

export const GET = withAuth<Loop, "/loops/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const loop = await loopsService.findById(id, user.organizationId);

      if (!loop) {
        return notFoundResponse("Loop");
      }

      return successResponse(loop);
    } catch (error) {
      return errorResponse("Failed to fetch loop", error);
    }
  }
);

export const DELETE = withAuth<Loop, "/loops/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const loop = await loopsService.cancel(id, user.organizationId);

      return successResponse(loop);
    } catch (error) {
      return errorResponse("Failed to cancel loop", error);
    }
  }
);
