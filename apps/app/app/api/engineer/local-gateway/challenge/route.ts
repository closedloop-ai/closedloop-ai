import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { resolveApiOrigin } from "@/lib/api-origin";

type ChallengeApiResult =
  | { success: true; data: { challengeToken: string; expiresAt: string } }
  | { success: false; error: string };

/**
 * POST /api/engineer/local-gateway/challenge
 *
 * Same-origin bridge route: the browser calls this to obtain a challenge JWT
 * for the local gateway auth exchange. Forwards the request to the API's
 * /compute-targets/local-auth/challenge endpoint using the user's session token.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const { userId, getToken } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = await getToken();
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { origin?: string };
  try {
    body = (await request.json()) as { origin?: string };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const origin = body.origin;
  if (!origin || typeof origin !== "string") {
    return NextResponse.json(
      { error: "origin is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const apiOrigin = resolveApiOrigin(request);

  try {
    const response = await fetch(
      `${apiOrigin}/compute-targets/local-auth/challenge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ origin }),
        cache: "no-store",
      }
    );

    const data = (await response.json()) as ChallengeApiResult;

    if (response.ok && data.success) {
      return NextResponse.json(data.data, {
        status: response.status,
        headers: { "Cache-Control": "no-store" },
      });
    }

    return NextResponse.json(
      { error: data.success ? "Failed to obtain challenge token" : data.error },
      {
        status: response.status,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    log.error("Failed to fetch local gateway challenge", { error });
    return NextResponse.json(
      { error: "Failed to obtain challenge token" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
