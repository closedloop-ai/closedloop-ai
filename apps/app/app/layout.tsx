import { Surface } from "@repo/api/src/types/surface-analytics";
import { env } from "@/env";
import { bootstrapsFeatureFlags } from "@/lib/analytics/feature-flag-bootstrap";
import { resolvePinnedFeatureFlags } from "@/lib/analytics/pinned-feature-flags";
import { AppSurfaceAnalyticsProvider } from "@/lib/analytics/surface-analytics-adapter";
import { resolvePreconnectApiOrigin } from "@/lib/api-origin";
import { AppCoreAdapterProvider } from "@/lib/app-core-adapters";
import { DatadogRouteViewTracker } from "@/lib/datadog-rum/route-view-tracker";
import { resolveApiDeploymentPin } from "@/lib/deployment-pin";
import { appEnvironment, envIconPath } from "@/lib/environment";
import { AppNavigationProvider } from "@/lib/navigation/next-adapter";
import { QueryCacheScopeBinding } from "@/lib/query-cache-scope-binding";
import { QueryProvider } from "@/lib/query-client";
import { RootAuthProvider } from "@/lib/root-auth-provider";
import { isRootLayoutFailureValidationRequest } from "@/lib/root-layout-failure-validation";
import "./styles.css";
import { AnalyticsProvider } from "@repo/analytics/provider";
import {
  isLocalTrustedAuthActive,
  resolveLocalTrustedIdentity,
} from "@repo/auth/auth-mode";
import { DesignSystemProvider } from "@repo/design-system";
import { fonts } from "@repo/design-system/lib/fonts";
import type { Metadata, Viewport } from "next";
import { Silkscreen } from "next/font/google";
import { headers } from "next/headers";
import type { ReactNode } from "react";

const silkscreen = Silkscreen({
  variable: "--font-pixel",
  subsets: ["latin"],
  weight: ["400", "700"],
});

// ISS-8950 Property 1: the nonce mechanism depends on every route beneath this
// layout NEVER being statically prerendered. A prerendered document is HTML
// frozen at build time, so it cannot carry the per-request `nonce-…` the
// middleware stamps into `script-src` — every script on it violates an
// ENFORCING policy, in the user's browser, with nothing server-side to notice.
//
// This is not only a documentation change. The `await headers()` read below
// forces dynamic rendering as a SIDE EFFECT of fetching the nonce, but it sits
// behind `env.CSP_ENABLED`, which `packages/security/keys.ts` declares
// `.optional()` with no default — so on a deployment that never sets it, the
// branch is not taken and nothing forced dynamic rendering at all.
//
// The accident is exactly how it broke on `apps/web` (ISS-8949), whose root
// layout carries the identical read: its 404 does not route through that
// layout, so it prerendered, edge-cached, and served 9 scripts with 0 nonces.
//
// `app/global-error.tsx` renders its own `<html>` and so is NOT beneath this
// layout — neither the segment config here nor the nonce below reaches it.
// ISS-9070 established that neither has to, and that the escape this comment
// used to name is not one. Next parses the nonce out of the REQUEST's
// `content-security-policy` header, which Clerk forwards onto the request as
// well as the response, and stamps it on every script it emits — including on
// the error-recovery document that a root-layout throw produces, which is
// where `global-error.tsx` renders. Measured on a production build of this app
// under the ENFORCING policy: 16 scripts, all 16 carrying the header's nonce,
// 0 violations, the component rendered from client JS, and "Try again"
// reaching `reset()`, which ISS-11423 replaced with `retry()`;
// `e2e/global-error-csp-nonce.local-trusted.spec.ts` re-measures that in a
// browser (ISS-10078), and that `retry()` recovers (ISS-11423). Do NOT thread
// the nonce below into it: it works because it emits no script of its own,
// which `__tests__/app/error-boundaries.test.tsx` pins.
//
// What ISS-9070 leaves open is a different document and not this layout's to
// fix. Next prerenders its OWN `_global-error` at build time — that synthetic
// route drops the app config, so `force-dynamic` above never applies to it —
// and copies it to `pages/500.html`. That is Next's built-in 500 page, not
// this app's global-error, and having been built with no request it carries no
// nonce: 19 scripts (18 before Next 16.4.1 inlined its chunk-group bootstrap,
// ISS-12940; 19 before ISS-12054 regrouped its chunks), all blocked
// under the enforcing policy. On Vercel a
// page crash outside app-render's recovery serves it on the original request
// url; `next start` returns a plain-text 500 instead (ISS-11059).
// `scripts/check-static-500.mjs` re-measures it on every CI build.
//
// Pinned by `__tests__/root-layout-dynamic-rendering.test.ts`, which reads the
// declaration. Only a build shows the resulting per-route classification.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Closedloop.ai",
  icons: {
    icon: envIconPath[appEnvironment],
  },
};

// FEA-3861: `viewport-fit=cover` lets the app draw into the notch/home-indicator
// area so `env(safe-area-inset-*)` resolves to real values on iOS PWA/WebView;
// without it the insets read 0 and the mobile bottom-nav would sit under the
// home indicator.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

type RootLayoutProperties = {
  readonly children: ReactNode;
};

const RootLayout = async ({ children }: RootLayoutProperties) => {
  // ISS-10078: e2e-only; unreachable on any deployment (see the predicate).
  if (
    isRootLayoutFailureValidationRequest(
      env.ERROR_BOUNDARY_VALIDATION_ROUTE_ENABLED,
      await headers()
    )
  ) {
    throw new Error("ISS-10078 root layout failure validation");
  }
  // Fetches the nonce, and nothing more: `export const dynamic` above now owns
  // the render mode outright, so removing this read costs the nonce without
  // silently costing the dynamic-render guarantee too (ISS-8950).
  const nonce = env.CSP_ENABLED
    ? ((await headers()).get("x-nonce") ?? undefined)
    : undefined;
  // Every authenticated page's first reads go to a third origin (the BFF), so
  // the browser pays DNS + TCP + TLS on the critical path before `/me` can be
  // sent. Hinted here rather than from a client effect: the hint has to be in
  // the document the browser is already parsing to beat the first read to it.
  // `host`, never `x-forwarded-host`: the browser derives a preview's API
  // origin from the address it asked for, which is this header.
  const browserApiOrigin = resolvePreconnectApiOrigin(
    (await headers()).get("host")
  );

  // FEA-1485: resolve the api-prod deployment pin server-side and hand it to
  // the client adapter so app→api fetches forward `x-deployment-id`.
  const apiDeploymentId = await resolveApiDeploymentPin();
  // ISS-12048: a `$vibe` preview's production flag snapshot, `null` elsewhere.
  const pinnedFeatureFlags = await resolvePinnedFeatureFlags();
  // ISS-10335: the ids are resolved, not fixed — the Clerk-free e2e lane binds
  // them to the seeded sandbox org. The client identity has to be the SAME one
  // the server session reports, or the org header the app sends would name a
  // different org than `auth()` authenticated as, and every api read would come
  // back `org_unverifiable` (apps/api/lib/auth/resolve-org-header.ts).
  const localTrustedAuthIdentity = isLocalTrustedAuthActive()
    ? resolveLocalTrustedIdentity()
    : null;

  return (
    <html
      className={`${fonts} ${silkscreen.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <body className="overflow-hidden">
        {browserApiOrigin && (
          <link
            crossOrigin="anonymous"
            href={browserApiOrigin}
            rel="preconnect"
          />
        )}
        <DatadogRouteViewTracker />
        <QueryProvider>
          <AnalyticsProvider
            apiOrigin={
              // Default on (Perrin 2026-10-05, #8333).
              env.POSTHOG_TRACING_HEADERS_ENABLED === "false"
                ? null
                : browserApiOrigin
            }
            bootstrapFeatureFlags={bootstrapsFeatureFlags(
              env.E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP,
              env.NEXT_PUBLIC_APP_ENVIRONMENT,
              env.NEXT_PUBLIC_APP_URL
            )}
            context={{ surface: Surface.Web, environment: appEnvironment }}
            nonce={nonce}
            trackPageViews
          >
            <AppSurfaceAnalyticsProvider>
              <DesignSystemProvider nonce={nonce}>
                <RootAuthProvider
                  localTrustedAuthIdentity={localTrustedAuthIdentity}
                  nonce={nonce}
                >
                  {/* ISS-7442: must stay the FIRST child here — it binds the
                      query cache to the signed-in identity during render, and
                      everything below reads the cache. */}
                  <QueryCacheScopeBinding />
                  <AppCoreAdapterProvider
                    apiDeploymentId={apiDeploymentId}
                    localTrustedAuthIdentity={localTrustedAuthIdentity}
                    pinnedFeatureFlags={pinnedFeatureFlags}
                  >
                    <AppNavigationProvider>{children}</AppNavigationProvider>
                  </AppCoreAdapterProvider>
                </RootAuthProvider>
              </DesignSystemProvider>
            </AppSurfaceAnalyticsProvider>
          </AnalyticsProvider>
        </QueryProvider>
      </body>
    </html>
  );
};

export default RootLayout;
