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

  return (
    <OrgIdentityProvider orgSlug={orgSlug}>{children}</OrgIdentityProvider>
  );
}
