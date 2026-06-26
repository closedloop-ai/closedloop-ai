export const ORG_IDENTITY_HEADER = "X-Organization-Id" as const;

/**
 * Vercel skew-protection request header (FEA-1485). When app-prod is pinned to
 * a specific api-prod deployment for the commit it was built from, the client
 * forwards that deployment uid here so the custom cross-origin app→api fetch
 * routes to the matching api deployment even after the api-prod alias moves.
 * Honored by Vercel's platform routing, gated by api-prod Allowed Domains
 * (FEA-1483). Omitted when no pin is resolved (preview / non-prod / no entry).
 *
 * Dual-app, like {@link ORG_IDENTITY_HEADER}: the frontend sets it
 * (`packages/app/shared/api/use-api-client.ts`) and the api must advertise it
 * in its CORS `Access-Control-Allow-Headers` (`apps/api/lib/cors.ts`), or the
 * browser preflight blocks the request — hence the shared-types home.
 */
export const DEPLOYMENT_ID_HEADER = "x-deployment-id" as const;
