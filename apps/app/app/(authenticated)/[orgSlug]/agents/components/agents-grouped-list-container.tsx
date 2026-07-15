"use client";

/**
 * Thin client wrapper for the web Agents workspace list, supplying the GitHub
 * connection state that drives the Owner-column Connect-GitHub CTA
 * (FEA-2923 follow-up).
 *
 * Kept as a separate client component so that agents/page.tsx remains a
 * Server Component (able to export Next.js `metadata`).
 *
 * NOTE: `getComponentHref` is intentionally NOT passed — the per-component
 * detail page is not built yet, so rows are non-clickable to avoid navigating
 * to a 404. Re-add the href factory once the detail route lands.
 */

import { AgentsGroupedList } from "@repo/app/agents/components/workspace/agents-grouped-list";
import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import {
  resolveGitHubConnectMode,
  resolveGitHubDataConnected,
} from "@repo/app/insights/lib/github-connect-mode";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { getGitHubConnectUrl } from "@/lib/integration-connect-urls";
import { MemberPacksDashboard } from "./member-packs-dashboard";

export function AgentsGroupedListContainer() {
  const orgSlug = useOrgSlug();

  // Owner attribution (git-identity → cloud user) needs a GitHub connection.
  // Resolve the additive data-connection predicate via the insights helper so
  // the Owner column shows the reused Connect-GitHub CTA when it is missing.
  const { data: githubStatus } = useGitHubIntegrationStatus();
  const githubConnected = resolveGitHubDataConnected(githubStatus);

  // Build the connect target the same way Insights does: pick the right OAuth
  // flow (install vs authorize) and set `returnTo` to the Agents route so the
  // OAuth callback brings the user back to this surface instead of dropping
  // them on /settings. The server-side allowlist
  // (getCanonicalBranchViewReturnPath) must honor the /agents return target.
  const githubConnectHref = getGitHubConnectUrl(
    resolveGitHubConnectMode(githubStatus),
    { returnTo: `/${orgSlug}/agents` }
  );

  return (
    <AgentsGroupedList
      githubConnected={githubConnected}
      githubConnectHref={githubConnectHref}
      persistKey="agents:web"
      // Self-service Plugins tab: mount the shared, prototype-styled Packs
      // workspace (member, read-only) below the plugin component list — the same
      // footer-slot integration the desktop panel uses, so a regular member gets
      // the admin-parity browse/detail UX for their org's Packs.
      pluginsFooter={<MemberPacksDashboard />}
    />
  );
}
