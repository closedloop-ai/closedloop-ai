import {
  type AppEnvironment,
  PRODUCTION_APP_HOST,
} from "@repo/analytics/environment";
import { isValidGaMeasurementId } from "@repo/analytics/keys";
import { LIVEBLOCKS_CONNECTION_ORIGINS } from "@repo/api/src/types/liveblocks-connection";

/**
 * Whether a Content-Security-Policy should be attached at all by the
 * middleware for the current deployment. Whether that policy is enforced or
 * report-only is a separate question — `enforcesContentSecurityPolicy`.
 *
 * Enabled only when CSP_ENABLED === "true" AND the deployment is not a Vercel
 * preview. A policy on ephemeral preview / e2e deployments yields no
 * actionable signal but floods Datadog RUM with `csp_violation` errors that
 * bury real prod signal (FEA-1466): the preview API host is derived per
 * deployment and the e2e harness drives the app against hosts that never match
 * the build-time `connect-src` allowlist. Real prod and stage (both Vercel
 * `production` targets, VERCEL_ENV !== "preview") retain the policy.
 */
export function shouldEnableContentSecurityPolicy(
  cspEnabled: string | undefined,
  vercelEnv: string | undefined
): boolean {
  return cspEnabled === "true" && vercelEnv !== "preview";
}

/**
 * Vercel aliases every deployment of a production-target project under
 * `*.preview.stage.example`, and `resolveApiOrigin` rewrites that host
 * `app-*` → `api-*` at runtime — so the origin the browser actually streams
 * from is a per-deployment host, never the build-time `NEXT_PUBLIC_API_URL`
 * baked into `connect-src` (ISS-7218).
 *
 * Stage and prod aliases share this parent domain and a CSP host-source cannot
 * wildcard part of a label (`api-stage-*.…` is not valid grammar), so the
 * directive itself cannot tell them apart. The scoping therefore has to happen
 * at the deployment assembling the policy — see `isStageDeployment`.
 *
 * `rewritePreviewHostname` also rewrites a `.vercel.app` alias, which gets no
 * source here on purpose: `shouldEnableContentSecurityPolicy` attaches no
 * policy at all when `VERCEL_ENV === "preview"`, and `https://*.vercel.app`
 * would admit every Vercel-hosted site on the internet.
 *
 * The residual breadth this leaves — sibling `app-…` and `api-prod-…` hosts
 * under the same parent — is accepted, not accidental, and fenced by the
 * "breadth is fenced" block in `__tests__/content-security-policy.test.ts` so
 * it cannot grow. Emitting only the origin actually derived needs the request,
 * which this module-scope policy does not have: ISS-7499.
 *
 * ISS-8437 changed what that acceptance COSTS on stage without changing the
 * acceptance itself. While stage was report-only the breadth was cosmetic —
 * the policy permitted everything and merely under-reported. Stage now
 * enforces, so these sources are the ones actually permitted. That is still
 * strictly narrower than the report-only policy it replaces, which is why the
 * acceptance holds; it does mean ISS-7499 stopped being cleanup.
 */
const STAGE_API_DOMAIN = "stage.example";
const STAGE_PREVIEW_API_SOURCE = `https://*.preview.${STAGE_API_DOMAIN}`;

type ConnectSrcOptions = {
  apiUrl: string;
  environment: AppEnvironment;
  gaMeasurementId: string | undefined;
  electronHostnames: string[];
  // Per-environment presigned-URL origins (S3/R2 transcript + attachment
  // buckets) from CSP_EXTRA_CONNECT_SRC, validated by @repo/security keys
  // (ISS-7475).
  extraSources?: string[];
  // REALTIME_PUBLIC_URL, a wss:// URL; only its origin is admitted
  // (ISS-11210 requirement 11).
  realtimeUrl?: string;
  // DOC_SYNC_PUBLIC_URL, the document sync service's wss:// URL; only its
  // origin is admitted (PLN-2189 T-4.1).
  docSyncUrl?: string;
};

/** Assemble the `connect-src` allowlist for this deployment's policy. */
export function buildConnectSrc({
  apiUrl,
  environment,
  gaMeasurementId,
  electronHostnames,
  extraSources,
  realtimeUrl,
  docSyncUrl,
}: ConnectSrcOptions): string[] {
  return [
    // The app's OWN origin, stated here rather than inherited (ISS-9123).
    // Clerk's `DEFAULT_DIRECTIVES` put `self` in `connect-src`, and
    // `buildContentSecurityPolicyDirectives` then `add()`s the request host to
    // that same Set — but this array REPLACES the Set whole if `connect-src`
    // ever leaves those defaults (`handleCustomDirective`), and nothing in
    // this repo pins which branch Clerk takes: `packages/auth` asks for
    // `^7.2.3` while `7.2.5` resolves, so a lockfile refresh can move it with
    // no code change here. The policy ENFORCES on stage and prod (ISS-8437),
    // so losing it would block every same-origin fetch the app makes to its
    // own `/api/*` routes, in the user's browser, with nothing server-side to
    // notice. Zero delta today, since Clerk's merge dedupes into one Set.
    //
    // This is not a pinned copy of a Clerk value that could drift from its
    // original: `'self'` is a CSP keyword whose meaning is fixed by CSP3
    // §6.6.2.5, and it subsumes the request host Clerk `add()`s because that
    // host IS the document's origin. Clerk's REMAINING `connect-src` defaults
    // stay inherited and are deliberately NOT restated — they serve Clerk's own
    // telemetry and third-party widgets, not an app fetch, so losing them costs
    // beacons rather than the product. Enumerating them here would be a copy of
    // Clerk's list that goes stale the next time Clerk moves it, with nothing
    // to catch it; read the list off `DEFAULT_DIRECTIVES` instead.
    "self",
    apiUrl,
    ...LIVEBLOCKS_CONNECTION_ORIGINS,
    "https://browser-intake-datadoghq.com",
    "https://*.browser-intake-datadoghq.com",
    "https://*.posthog.com",
    // Liveblocks' comment emoji picker fetches emojibase data from jsdelivr
    // at runtime (ISS-7475 M2 attribution).
    "https://cdn.jsdelivr.net",
    // Include Google Analytics only when the measurement ID is one GA will
    // actually mount under. Without it, browser extension injections and
    // speculative GA requests are noise: false-positive reports where the
    // policy reports, blocked requests for beacons the deployment never
    // wanted where it enforces (ISS-8437).
    //
    // ISS-8950 Property 3: this is the SAME predicate `AnalyticsProvider`
    // gates `<GoogleAnalytics>` on, imported rather than re-derived, so the
    // allowlist and the mount cannot disagree. Plain truthiness here admitted
    // both hosts for a placeholder id (`G-placeholder-GAID`) that never
    // mounts GA — and would, symmetrically, have gone on admitting them for a
    // shape the mount had started rejecting. One predicate, two consumers.
    //
    // Scope is `apps/app`. `apps/web` lists GA's hosts unconditionally on
    // purpose, not by oversight: its layout also mounts a hard-coded
    // <GoogleTagManager gtmId>, which loads GA independently of this ID, so
    // gating that surface on the ID would cut beacons GTM really does send.
    ...(isValidGaMeasurementId(gaMeasurementId)
      ? [
          "https://www.google-analytics.com/",
          // GA4's measurement protocol also beacons to google.com/g/collect;
          // a deployment that configured GA needs both, or every page either
          // reports a violation or, under enforcement, loses the beacon.
          "https://www.google.com",
        ]
      : []),
    ...(isStageDeployment(apiUrl, environment)
      ? [STAGE_PREVIEW_API_SOURCE]
      : []),
    ...electronHostnames,
    ...(extraSources ?? []),
    ...(realtimeUrl ? [new URL(realtimeUrl).origin] : []),
    ...(docSyncUrl ? [new URL(docSyncUrl).origin] : []),
  ];
}

/**
 * `getAppEnvironment` spells BOTH "this is stage" and "I could not classify
 * this deployment" as `"stage"` — a fallback chosen to keep unknown hosts out
 * of the `env:prod` telemetry slice, where it is the conservative direction.
 * For both callers here it is the dangerous one, so the classification alone
 * never decides: stage must additionally be confirmed by an API origin on the
 * stage domain, which production's is not.
 *
 * EDITING THIS MOVES TWO DECISIONS WITH DIFFERENT BLAST RADII. It admits the
 * `connect-src` preview wildcard above, and — since ISS-8437 — it is also the
 * STAGE arm of `enforcesContentSecurityPolicy` (prod enforces on its own
 * label, not through here). Widening it does not just admit one more origin;
 * it turns enforcement on wherever it newly answers true. Widen the wildcard
 * at its own call site instead.
 */
function isStageDeployment(
  apiUrl: string,
  environment: AppEnvironment
): boolean {
  if (environment !== "stage") {
    return false;
  }

  try {
    const { hostname } = new URL(apiUrl);
    return (
      hostname === STAGE_API_DOMAIN || hostname.endsWith(`.${STAGE_API_DOMAIN}`)
    );
  } catch {
    return false;
  }
}

/**
 * Whether this deployment ENFORCES the policy rather than only reporting it
 * (ISS-8437 M4 of PLN-1782). Stage and production both enforce; every other
 * deployment reports.
 *
 * The two arms are deliberately asymmetric. Stage must ALSO be corroborated by
 * a stage API origin because `"stage"` is what `getAppEnvironment` returns for
 * a deployment it could not classify, so the label alone would enforce on
 * exactly the deployment nobody has checked. `"prod"` has no such fallback —
 * it is reached only by an explicit `NEXT_PUBLIC_APP_ENVIRONMENT=production`
 * or an exact `app.closedloop.ai` host.
 *
 * The prod label alone is nonetheless not sufficient, because ONE prod build
 * serves two hosts. Vercel also aliases it as
 * `app-prod-<hash>.preview.stage.example`, and on that host
 * `resolveApiOrigin` (`lib/api-origin.ts`) rewrites `app-*` → `api-*` in the
 * browser and hands the derived origin to the app-wide API client. Prod's
 * `connect-src` deliberately carries no `*.preview.stage.example` source
 * — admitting it would let every stage preview host into prod's policy, the
 * exact breadth the ISS-7499 fence exists to prevent — so enforcing on the
 * alias would block the whole data layer in the browser with nothing
 * server-side to notice (whitlockk, PR #6312). The canonical host is the only prod
 * host whose derived origin the policy already permits, so it is the only one
 * that enforces; the alias keeps reporting. Stage needs no such fence: its
 * `connect-src` DOES carry that wildcard, so its alias-derived origin is
 * already permitted.
 *
 * Still deliberately NOT `environment !== "stage"`, for the same reason as
 * before: that spelling reads the unclassified fallback as "enforce".
 */
export function enforcesContentSecurityPolicy(
  apiUrl: string,
  environment: AppEnvironment,
  requestHostname: string
): boolean {
  return (
    isStageDeployment(apiUrl, environment) ||
    (environment === "prod" && requestHostname === PRODUCTION_APP_HOST)
  );
}
