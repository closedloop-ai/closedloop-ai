import "server-only";

import { failure, success } from "@repo/api/src/types/common";
import { redis } from "@repo/rate-limit";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isLocalGatewayJwtConfigured,
  issueLocalGatewayChallenge,
  LOCAL_GATEWAY_CHALLENGE_TTL_SECONDS,
} from "@/lib/auth/local-gateway-jwt";
import { isLocalGatewayOriginAllowed } from "@/lib/auth/local-gateway-origins";
import { withAuth } from "@/lib/auth/with-auth";

const JTI_REDIS_TTL_SECONDS = LOCAL_GATEWAY_CHALLENGE_TTL_SECONDS + 10;

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
    });
  }

  const rawBody = await request.json().catch(() => null);
  const parseResult = challengeRequestValidator.safeParse(rawBody);
  if (!parseResult.success) {
    return NextResponse.json(
      failure("Invalid request body: origin is required"),
      {
        status: 400,
      }
    );
  }

  const { origin } = parseResult.data;

  if (!isLocalGatewayOriginAllowed(origin)) {
    return NextResponse.json(failure("Origin is not trusted"), {
      status: 400,
    });
  }

  const { jwt, jti, expiresAt } = await issueLocalGatewayChallenge({
    userId: user.id,
    orgId: user.organizationId,
    origin,
  });

  await redis.set(`local-auth:jti:${jti}`, "pending", {
    ex: JTI_REDIS_TTL_SECONDS,
  });

  return NextResponse.json(
    success({ challengeToken: jwt, expiresAt: expiresAt.toISOString() })
  );
});
