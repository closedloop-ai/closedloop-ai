import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const LINK_UNFURLER_PATTERN =
  /Slackbot|Twitterbot|facebookexternalhit|LinkedInBot|WhatsApp|TelegramBot|Discordbot|iMessageBotUser/i;

export const ARTIFACT_PATH_PATTERN =
  /^\/(prds|implementation-plans|artifacts|issues)\/([^/?#]+)$/;

/**
 * Rewrites link-unfurler bot requests for authenticated artifact routes to the
 * public `/og/<slug>` route so bots receive proper Open Graph metadata instead
 * of following the sign-in redirect and reading sign-in page metadata.
 */
export function rewriteForLinkUnfurler(
  request: NextRequest
): NextResponse | null {
  const userAgent = request.headers.get("user-agent") ?? "";
  if (!LINK_UNFURLER_PATTERN.test(userAgent)) {
    return null;
  }

  const match = ARTIFACT_PATH_PATTERN.exec(request.nextUrl.pathname);
  if (!match) {
    return null;
  }

  const slug = match[2];
  const url = request.nextUrl.clone();
  url.pathname = `/og/${slug}`;
  return NextResponse.rewrite(url);
}
