"use client";

import { useAgentComponentDetail } from "@repo/app/agents/hooks/use-agent-component-detail";
import { agentBreadcrumbLabel } from "@repo/app/agents/lib/agent-slug-label";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Header } from "@/app/(authenticated)/components/header";

/**
 * ISS-5518: the Agents component-detail breadcrumb + browser-tab title.
 *
 * `agentBreadcrumbLabel` has taken a `resolvedName` since FEA-4335 and its
 * docstring asserts "the page passes the resolved `component.name` when it has
 * one" — but no production caller ever did, because the only caller was the
 * route's Server Component and the name is resolved client-side. The parameter
 * shipped dead, so every content-hash route (which the service now emits for
 * every row with a captured definition, `service.ts` `routableKey`) fell to the
 * neutral `"Agent"` fallback and two agents were indistinguishable from their
 * trail.
 *
 * This is the client boundary that supplies it, and it is the same shape the
 * Sessions/Branches detail routes already use (`sessions/[id]/page.tsx`): ONE
 * resolved label feeds both the crumb and the tab, so those two cannot disagree
 * by construction. It re-reads `useAgentComponentDetail(slug)` rather than
 * lifting state — same query key as the body's own read, so TanStack serves it
 * from cache and no second request is issued.
 *
 * Before the record resolves, `agentBreadcrumbLabel` falls back exactly as it
 * does today (the neutral `"Agent"`, or a legacy slug's own human key). That is
 * the honest generic `useDocumentTitle` asks for — it names the kind of page,
 * where a raw digest would read as a name the record does not have.
 */
export function AgentDetailHeader({
  orgSlug,
  slug,
}: {
  orgSlug: string;
  slug: string;
}) {
  const honest = useFeatureFlagEnabled(AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY);
  const { data } = useAgentComponentDetail(slug);
  // Flag OFF resolves to `undefined`, which is byte-for-byte the pre-flag
  // single-argument call — the gate changes nothing until it is turned on.
  const label = agentBreadcrumbLabel(slug, honest ? data?.name : undefined);
  // `null` leaves the route's static `metadata.title` in place while the flag is
  // off; see `useDocumentTitle` for why that is the opt-out and not a "loading"
  // signal.
  useDocumentTitle(honest ? label : null);

  return (
    <Header
      breadcrumbs={[{ href: `/${orgSlug}/agents`, label: "Agents" }, { label }]}
      suppressPageHeading
    />
  );
}
