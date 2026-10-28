import { DesktopAuthorizeConsent } from "@repo/app/onboarding/components/desktop-authorize-consent";
import { resolveDesktopRunAccountCreated } from "@/lib/desktop-authorize-run-account-created";

/**
 * Bare (no org slug) desktop authorize route (FEA-2460).
 *
 * The Clerk middleware (`apps/app/proxy.ts`) rewrites `/settings/…` to
 * `/{orgSlug}/settings/…` whenever the session has an active org, and Clerk is
 * configured to require an org at signup — so a signed-in user always lands on
 * the org-scoped route. This bare path is a defensive fallback: the consent
 * flow still works (the mint resolves the user's org from the session), and if
 * no org can be resolved the mint surfaces a typed error rather than a 404.
 * Whether this run created the account is derived here, on the server
 * (ISS-11395).
 */
export default async function DesktopAuthorizeBarePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const accountCreated = await resolveDesktopRunAccountCreated({
    searchParams: resolvedSearchParams,
  });

  return (
    <DesktopAuthorizeConsent
      accountCreated={accountCreated}
      searchParams={resolvedSearchParams}
    />
  );
}
