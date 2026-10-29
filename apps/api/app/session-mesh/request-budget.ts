import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";

/** Hot-instance abuse protection, not an authorization or durable quota. */
export class MeshRequestBudget {
  private readonly reads = new FixedWindowRateLimiter({ maxRequests: 1200 });
  private readonly heartbeats = new FixedWindowRateLimiter({
    maxRequests: 1200,
  });
  private readonly writes = new FixedWindowRateLimiter({ maxRequests: 120 });

  check(
    request: Request,
    organizationId: string,
    userId: string
  ): NextResponse<ApiResult<never>> | null {
    const key = JSON.stringify([organizationId, userId]);
    let limiter = this.writes;
    if (request.method === "GET") {
      limiter = this.reads;
    } else if (new URL(request.url).pathname.endsWith("/presence")) {
      limiter = this.heartbeats;
    }
    if (limiter.attempt(key, Date.now())) {
      return null;
    }
    return NextResponse.json(
      failure("Session Mesh request budget exceeded", {
        code: "session_mesh_rate_limited",
      }),
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
}

export const meshRequestBudget = new MeshRequestBudget();
