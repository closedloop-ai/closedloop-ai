import { postHogMiddleware } from "@posthog/next";
import { NextResponse } from "next/server";
import { keys } from "./keys";

const { NEXT_PUBLIC_POSTHOG_KEY } = keys();

export function analyticsMiddleware(
  response?: NextResponse
): ReturnType<typeof postHogMiddleware> {
  return NEXT_PUBLIC_POSTHOG_KEY
    ? postHogMiddleware({
        proxy: true,
        response,
      })
    : () => Promise.resolve(response ?? NextResponse.next());
}
