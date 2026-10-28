/**
 * ISS-12054: the local-trusted CSP builder (`local-trusted-csp.ts`) mirrors the
 * one inside `clerkMiddleware`, which Clerk does not export. This runs the
 * installed Clerk middleware and the mirror over the same options and compares
 * the policies, so a Clerk upgrade that moves its default directives fails here
 * instead of leaving the Clerk-free lane on a different policy than Clerk would
 * serve. The two differ only where they must: the nonce is random per request,
 * and only Clerk's carries its Frontend API host.
 */
import { type NextFetchEvent, NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildContentSecurityPolicyHeaders,
  type ContentSecurityPolicyOptions,
} from "../local-trusted-csp";

// The throwaway placeholders `content-security-policy-nonce-forwarding.test.ts`
// boots Clerk with. Their Frontend API host is the one Clerk adds to
// `connect-src`.
const PUBLISHABLE_KEY = "pk_live_Y2xlcmsuZTJlLXdlYi1zbW9rZS5pbnZhbGlkJA==";
const SECRET_KEY = "sk_live_e2ewebsmokedummynotarealkey0123456789";
const CLERK_FRONTEND_API_HOST = "clerk.e2e-web-smoke.invalid";
const NONCE_SOURCE = /'nonce-[^']+'/g;
const NONCE_PLACEHOLDER = "'nonce-N'";
const NONCE_HEADER = "x-nonce";
const NO_EVENT = { waitUntil: () => undefined } as unknown as NextFetchEvent;

const OPTION_SHAPES: [string, ContentSecurityPolicyOptions][] = [
  [
    "strict and enforcing, as apps/app asks on stage and prod",
    {
      strict: true,
      reportOnly: false,
      reportTo: "https://csp.example.invalid/report",
      directives: {
        "base-uri": ["none"],
        "connect-src": ["self", "https://api.example.invalid"],
        "img-src": ["self", "data:", "https://img.example.invalid"],
      },
    },
  ],
  [
    "report-only and not strict",
    {
      reportOnly: true,
      directives: { "frame-ancestors": ["none"] },
    },
  ],
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the local-trusted CSP mirrors clerkMiddleware's", () => {
  it.each(OPTION_SHAPES)("%s", async (_label, options) => {
    const clerkHeaders = await clerkPolicyHeaders(options);
    const mirrorHeaders = new Map(
      buildContentSecurityPolicyHeaders(options, "mirror-nonce")
    );

    const names = [...mirrorHeaders.keys()].sort();
    for (const name of names) {
      expect(clerkHeaders.has(name), name).toBe(true);
    }
    // The nonce header is random per request, so only its presence is compared;
    // `normalize` folds the policy's own nonce source the same way.
    for (const name of names.filter((header) => header !== NONCE_HEADER)) {
      expect(normalize(mirrorHeaders.get(name) ?? ""), name).toBe(
        normalize(clerkHeaders.get(name) ?? "")
      );
    }
  });
});

async function clerkPolicyHeaders(
  options: ContentSecurityPolicyOptions
): Promise<Headers> {
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", PUBLISHABLE_KEY);
  vi.stubEnv("CLERK_SECRET_KEY", SECRET_KEY);
  vi.resetModules();
  const { clerkMiddleware } = await import("@clerk/nextjs/server");
  const middleware = clerkMiddleware(() => undefined, {
    contentSecurityPolicy: options,
  });
  const response = await middleware(
    new NextRequest("https://app.closedloop.ai/dashboard"),
    NO_EVENT
  );
  if (!(response instanceof Response)) {
    throw new Error("clerkMiddleware returned no response to read headers off");
  }
  return response.headers;
}

/** Drops the per-request nonce value and Clerk's own Frontend API host. */
function normalize(value: string): string {
  return value
    .replaceAll(NONCE_SOURCE, NONCE_PLACEHOLDER)
    .split("; ")
    .map((directive) =>
      directive
        .split(" ")
        .filter((token) => token !== CLERK_FRONTEND_API_HOST)
        .join(" ")
    )
    .join("; ");
}
