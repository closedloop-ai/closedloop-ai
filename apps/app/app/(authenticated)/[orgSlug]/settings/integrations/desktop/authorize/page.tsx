import { DesktopAuthorizeConsent } from "@repo/app/onboarding/components/desktop-authorize-consent";
import { resolveDesktopRunAccountCreated } from "@/lib/desktop-authorize-run-account-created";

/**
 * Org-scoped desktop authorize/consent route (FEA-2460). The desktop opens
 * `/settings/integrations/desktop/authorize?…`; the Clerk middleware
 * (`apps/app/proxy.ts`) rewrites it here once the session has an active org.
 * The OAuth params (PKCE challenge, `state`, loopback `redirect_uri`, gateway
 * id + key, device metadata) arrive as query params and pass through to the
 * consent component, which mints the code and hands back to the loopback.
 * Whether this run created the account is derived here, on the server
 * (ISS-11395).
 */
export default async function DesktopAuthorizePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ orgSlug }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  const accountCreated = await resolveDesktopRunAccountCreated({
    searchParams: resolvedSearchParams,
  });

  return (
    <DesktopAuthorizeConsent
      accountCreated={accountCreated}
      requestedOrgSlug={orgSlug}
      searchParams={resolvedSearchParams}
    />
  );
}
