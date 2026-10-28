"use client";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AgentDetail } from "@repo/app/agents/components/workspace/agent-detail";
import { PromoteModal } from "@repo/app/agents/components/workspace/promote-modal";
import { TokenTrendChart } from "@repo/app/agents/components/workspace/token-trend-chart";
import { isPromotableKind } from "@repo/app/agents/lib/component-meta";
import { isAdminRole } from "@repo/app/shared/lib/role-utils";
import { useOrganization } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import { RocketIcon } from "lucide-react";
import { useState } from "react";

/**
 * Web mount of the shared {@link AgentDetail} that adds the admin-gated
 * "Promote & Distribute" header action (FEA-2923 / T-17.4).
 *
 * The Clerk-based org-admin gate lives here in `apps/app` — not in the shared
 * `@repo/app` component — so the desktop shell (which has no Clerk) keeps
 * rendering `AgentDetail` without a promote action. Non-admins get no button,
 * mirroring the server-side `org:admin` guard on POST /agent-components/promote.
 */
export function AgentDetailWithPromote({
  orgSlug,
  slug,
}: {
  orgSlug: string;
  slug: string;
}) {
  const { membership } = useOrganization();
  const isAdmin = isAdminRole(membership?.role);

  return (
    <AgentDetail
      analytics={(component) => (
        <TokenTrendSection component={component} slug={slug} />
      )}
      // Web Agents list route, matching the breadcrumb's "Agents" crumb, so the
      // not-found state's "Back to Agents" link navigates (FEA-3987).
      backHref={`/${orgSlug}/agents`}
      // Web session-detail route, matching the Sessions/Insights pages
      // (`/{orgSlug}/sessions/{id}`), so the Sessions-tab name navigates.
      getSessionHref={(row) => `/${orgSlug}/sessions/${row.id}`}
      headerAction={(component) => (
        <HeaderActions component={component} isAdmin={isAdmin} />
      )}
      slug={slug}
    />
  );
}

/**
 * The component-detail header action: "Promote", admin-only and hidden for
 * non-distributable kinds (FEA-3048). Returns null when it does not apply so
 * the header shows no empty action slot.
 */
function HeaderActions({
  component,
  isAdmin,
}: {
  component: AgentComponentDetail;
  isAdmin: boolean;
}) {
  // FEA-3048: observable-only kinds (built-in Tool/Config) are not distributable
  // — hide Promote even for admins (the server-side guard in
  // agent-components/promote rejects them regardless).
  const showPromote = isAdmin && isPromotableKind(component.kind);

  if (!showPromote) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <PromoteHeaderAction component={component} />
    </div>
  );
}

/**
 * Web-only usage-trend section. Rendered via the shared {@link AgentDetail}
 * `analytics` slot so the HTTP-backed {@link TokenTrendChart} (GET
 * /agent-components/{slug}/token-trend) mounts only on web, never on the desktop
 * shell whose inert REST adapter always rejects. FEA-4027: the chart carries the
 * dashboard's metric/grouping toggles (model / provider / tokens / dollars) and
 * version-lifecycle markers, so it takes the component's `versions` +
 * `usageSessions` to place the markers.
 */
function TokenTrendSection({
  component,
  slug,
}: {
  component: AgentComponentDetail;
  slug: string;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="font-semibold text-lg tracking-tight">Token trend</h2>
      <p className="text-muted-foreground text-sm">
        Per-model usage over time, bucketed by session start day. Toggle between
        tokens and spend, grouped by model or provider; vertical markers show
        when each version was created and first used.
      </p>
      <TokenTrendChart
        // ISS-4802: the same count the Sessions card renders, so the chart's
        // empty state can never deny usage already on screen.
        sessions={component.sessions}
        slug={slug}
        usageSessions={component.usageSessions}
        versions={component.versions}
      />
    </section>
  );
}

function PromoteHeaderAction({
  component,
}: {
  component: AgentComponentDetail;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <RocketIcon className="mr-1 size-4" />
        Promote
      </Button>
      <PromoteModal component={component} onOpenChange={setOpen} open={open} />
    </>
  );
}
