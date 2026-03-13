import "server-only";

import { failure, success } from "@repo/api/src/types/common";
import { redis } from "@repo/rate-limit";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isLocalGatewayJwtConfigured,
  issueLocalGatewayChallenge,
} from "@/lib/auth/local-gateway-jwt";
import { withAuth } from "@/lib/auth/with-auth";

const TRAILING_SLASH_REGEX = /\/$/;
const LEADING_DOT_REGEX = /^\./;
const DEFAULT_PREVIEW_SUFFIX = "preview.closedloop-stage.ai";
const LOCALHOST_ORIGIN_REGEX = /^http:\/\/localhost:\d+$/;
const JTI_REDIS_TTL_SECONDS = 120;

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>(["http://localhost:3000"]);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    origins.add(appUrl);
    origins.add(appUrl.replace(TRAILING_SLASH_REGEX, ""));
  }
  const webUrl = process.env.NEXT_PUBLIC_WEB_URL;
  if (webUrl) {
    origins.add(webUrl);
    origins.add(webUrl.replace(TRAILING_SLASH_REGEX, ""));
  }
  return origins;
}

function getPreviewSuffix(): string | null {
  const suffix =
    process.env.NEXT_PUBLIC_PREVIEW_DOMAIN ??
    process.env.PREVIEW_DOMAIN ??
    DEFAULT_PREVIEW_SUFFIX;
  const normalized = suffix.replace(LEADING_DOT_REGEX, "").trim();
  return normalized.length > 0 ? normalized : null;
}

function isOriginAllowed(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (getAllowedOrigins().has(origin)) {
    return true;
  }

  if (
    process.env.NODE_ENV !== "production" &&
    LOCALHOST_ORIGIN_REGEX.test(origin)
  ) {
    return true;
  }

  const suffix = getPreviewSuffix();
  if (suffix && hostname.endsWith(suffix.toLowerCase())) {
    return true;
  }

  if (hostname.endsWith(".vercel.app") && hostname.startsWith("app-")) {
    return true;
  }

  return false;
}

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
      headers: { "Cache-Control": "no-store" },
    });
  }

  const rawBody = await request.json().catch(() => null);
  const parseResult = challengeRequestValidator.safeParse(rawBody);
  if (!parseResult.success) {
    return NextResponse.json(
      failure("Invalid request body: origin is required"),
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const { origin } = parseResult.data;

  if (!isOriginAllowed(origin)) {
    return NextResponse.json(failure("Origin is not trusted"), {
      status: 400,
      headers: { "Cache-Control": "no-store" },
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
    success({ challengeToken: jwt, expiresAt: expiresAt.toISOString() }),
    { headers: { "Cache-Control": "no-store" } }
  );
});
