import { type NextRequest, NextResponse } from "next/server";
import {
  applyDesktopAuthorizeRunCookieUpdate,
  consumeDesktopAuthorizeRunCookie,
} from "@/lib/desktop-authorize-run";

/**
 * Consumes the pending desktop authorize run (PLN-2118): the consent page calls
 * it before handing back to the desktop on both mint success and cancel, which
 * is what makes a run single-use. The run stays in the cookie marked consumed
 * rather than being cleared, so revisiting the same authorize URL cannot re-arm
 * it. It only rewrites the caller's own cookie, so it needs no session.
 */
export function DELETE(request: NextRequest): NextResponse {
  const response = new NextResponse(null, { status: NO_CONTENT_STATUS });
  applyDesktopAuthorizeRunCookieUpdate(
    response,
    consumeDesktopAuthorizeRunCookie(request, Date.now())
  );
  return response;
}

const NO_CONTENT_STATUS = 204;
