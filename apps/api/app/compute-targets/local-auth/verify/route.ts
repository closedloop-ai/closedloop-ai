import "server-only";

import { failure, success } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { redis } from "@repo/rate-limit";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isLocalGatewayJwtConfigured,
  verifyLocalGatewayChallenge,
} from "@/lib/auth/local-gateway-jwt";
import { withApiKeyAuth } from "@/lib/auth/with-api-key-auth";

const SESSION_TTL_SECONDS = 600;

const verifyRequestValidator = z.object({
  challengeToken: z.string().min(1),
  requestOrigin: z.string().min(1).max(2048),
  userAgent: z.string().max(512).optional(),
});

type VerifyResponse = {
  ok: true;
  sessionTtlSeconds: number;
};

export const POST = withApiKeyAuth<
  VerifyResponse,
  "/compute-targets/local-auth/verify"
>(async ({ user }, request) => {
  if (!isLocalGatewayJwtConfigured()) {
    return NextResponse.json(failure("Local gateway auth is not configured"), {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const rawBody = await request.json().catch(() => null);
  const parseResult = verifyRequestValidator.safeParse(rawBody);
  if (!parseResult.success) {
    return NextResponse.json(failure("Invalid request body"), {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { challengeToken, requestOrigin, userAgent } = parseResult.data;

  let claims: Awaited<ReturnType<typeof verifyLocalGatewayChallenge>>;
  try {
    claims = await verifyLocalGatewayChallenge(challengeToken);
  } catch (error) {
    log.warn("Local gateway challenge verification failed: invalid JWT", {
      error: parseError(error),
      userAgent,
    });
    return NextResponse.json(failure("Invalid or expired challenge token"), {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (claims.userId !== user.id || claims.orgId !== user.organizationId) {
    log.warn("Local gateway challenge verification failed: user/org mismatch", {
      challengeUserId: claims.userId,
      apiKeyUserId: user.id,
      challengeOrgId: claims.orgId,
      apiKeyOrgId: user.organizationId,
      userAgent,
    });
    return NextResponse.json(
      failure("Challenge was not issued for this API key owner"),
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (requestOrigin !== claims.origin) {
    log.warn("Local gateway challenge verification failed: origin mismatch", {
      requestOrigin,
      challengeOrigin: claims.origin,
      userId: user.id,
      userAgent,
    });
    return NextResponse.json(
      failure("Request origin does not match challenge origin"),
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  const prev = await redis.getdel(`local-auth:jti:${claims.jti}`);
  if (prev !== "pending") {
    log.warn(
      "Local gateway challenge verification failed: JTI already consumed or expired",
      {
        jti: claims.jti,
        userId: user.id,
        userAgent,
      }
    );
    return NextResponse.json(
      failure("Challenge has already been used or has expired"),
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  log.info("Local gateway challenge verified successfully", {
    userId: user.id,
    orgId: user.organizationId,
    origin: claims.origin,
    jti: claims.jti,
    userAgent,
  });

  return NextResponse.json(
    success({ ok: true as const, sessionTtlSeconds: SESSION_TTL_SECONDS }),
    { headers: { "Cache-Control": "no-store" } }
  );
});
