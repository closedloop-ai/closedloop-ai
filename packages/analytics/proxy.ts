import { postHogMiddleware } from "@posthog/next";
import type { NextResponse } from "next/server";

export function analyticsMiddleware(response?: NextResponse) {
  return postHogMiddleware({
    proxy: true,
    response,
  });
}
