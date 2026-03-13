import "server-only";

import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { z } from "zod";
import { registerJti } from "@/lib/auth/local-gateway-jti-store";
import {
  isLocalGatewayJwtConfigured,
  issueLocalGatewayChallenge,
} from "@/lib/auth/local-gateway-jwt";
import { isLocalGatewayOriginAllowed } from "@/lib/auth/local-gateway-origins";
import { withAuth } from "@/lib/auth/with-auth";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

const challengeRequestValidator = z.object({
  origin: z.string().min(1).max(2048),
});

type ChallengeResponse = {
  challengeToken: string;
  expiresAt: string;
};

export const POST = withAuth<
  ChallengeResponse,
  "/compute-targets/local-auth/challenge"
>(async ({ user }, request) => {
  if (!isLocalGatewayJwtConfigured()) {
    return NextResponse.json(failure("Local gateway auth is not configured"), {
      status: 503,
      headers: NO_STORE_HEADERS,
    });
  }

  const rawBody = await request.json().catch(() => null);
  const parseResult = challengeRequestValidator.safeParse(rawBody);
  if (!parseResult.success) {
    return NextResponse.json(
      failure("Invalid request body: origin is required"),
      {
        status: 400,
        headers: NO_STORE_HEADERS,
      }
    );
  }

  const { origin } = parseResult.data;

  if (!isLocalGatewayOriginAllowed(origin)) {
    return NextResponse.json(failure("Origin is not trusted"), {
      status: 400,
      headers: NO_STORE_HEADERS,
    });
  }

  const { jwt, jti, expiresAt } = await issueLocalGatewayChallenge({
    userId: user.id,
    orgId: user.organizationId,
    origin,
  });

  registerJti(jti);

  return NextResponse.json(
    { challengeToken: jwt, expiresAt: expiresAt.toISOString() },
    { headers: NO_STORE_HEADERS }
  );
});
