import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { resolveApiOrigin } from "@/lib/api-origin";

type ChallengeApiResult =
  | { challengeToken?: string; expiresAt?: string }
  | { error?: string }
  | { success: true; data: { challengeToken?: string; expiresAt?: string } }
  | { success: false; error: string };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function isRawChallengePayload(
  value: ChallengeApiResult
): value is { challengeToken?: string; expiresAt?: string } {
  return (
    typeof value === "object" && value !== null && "challengeToken" in value
  );
}

function isChallengeEnvelope(
  value: ChallengeApiResult
): value is {
  success: true;
  data: { challengeToken?: string; expiresAt?: string };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    value.success === true
  );
}

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
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const token = await getToken();
  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  let body: { origin?: string };
  try {
    body = (await request.json()) as { origin?: string };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const origin = body.origin;
  if (!origin || typeof origin !== "string") {
    return NextResponse.json(
      { error: "origin is required" },
      { status: 400, headers: NO_STORE_HEADERS }
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
    const payload = isChallengeEnvelope(data)
      ? data.data
      : isRawChallengePayload(data)
        ? data
        : null;

    if (
      response.ok &&
      payload !== null &&
      typeof payload.challengeToken === "string" &&
      typeof payload.expiresAt === "string"
    ) {
      return NextResponse.json(payload, {
        status: response.status,
        headers: NO_STORE_HEADERS,
      });
    }

    return NextResponse.json(
      {
        error:
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof data.error === "string"
            ? data.error
            : "Failed to obtain challenge token",
      },
      {
        status: response.ok ? 502 : response.status,
        headers: NO_STORE_HEADERS,
      }
    );
  } catch (error) {
    log.error("Failed to fetch local gateway challenge", { error });
    return NextResponse.json(
      { error: "Failed to obtain challenge token" },
      { status: 502, headers: NO_STORE_HEADERS }
    );
  }
}
