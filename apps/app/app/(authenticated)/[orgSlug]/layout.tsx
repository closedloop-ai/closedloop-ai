import { isLocalTrustedAuthActive } from "@repo/auth/auth-mode";
import { auth } from "@repo/auth/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import OrgIdentityProvider from "./org-identity-provider";

type OrgSlugLayoutProps = {
  readonly children: ReactNode;
  readonly params: Promise<{ orgSlug: string }>;
};

export default async function OrgSlugLayout({
  children,
  params,
}: OrgSlugLayoutProps) {
  const [authState, { orgSlug }] = await Promise.all([auth(), params]);

  if (!(authState.orgSlug || authState.orgId)) {
    notFound();
  }

  // ISS-4406: resolved here, on the server, per request — not from a
  // `NEXT_PUBLIC_*` flag. `app` and `app-visual` in `e2e/compose.yml` share one
  // built image and `NEXT_PUBLIC_*` is inlined at build time, so a build-arg
  // flag would bake the bypass into the Clerk-gated service too. A server-
  // computed prop keeps it per-service at runtime. Under real Clerk `AUTH_MODE`
  // is unset, so this is always `false`.
  return (
    <OrgIdentityProvider
      bypassClientOrgGate={isLocalTrustedAuthActive()}
      orgSlug={orgSlug}
    >
      {children}
    </OrgIdentityProvider>
  );
}
