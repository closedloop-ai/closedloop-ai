"use client";

import { ClientRedirect } from "@repo/app/shared/components/client-redirect";
import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { useOrgSlug } from "@/hooks/use-org-slug";

/**
 * `/{orgSlug}` is an entry point, not a screen: it forwards to the shell's
 * landing route.
 *
 * That forward used to branch on `WorkspaceExperience` — legacy landed on My
 * Tasks, v2 on Dashboard — which is why a legacy workspace still opened on My
 * Tasks. Dashboard is now where every workspace lands, so there is nothing to
 * resolve: the destination no longer depends on the experience tree, and the
 * page does not wait on it. Dropping that wait also removes the render the
 * `pending` branch spent showing nothing before it could pick a href.
 */
export default function App() {
  const orgSlug = useOrgSlug();

  return <ClientRedirect href={`/${orgSlug}${WEB_CANONICAL_LANDING_HREF}`} />;
}
