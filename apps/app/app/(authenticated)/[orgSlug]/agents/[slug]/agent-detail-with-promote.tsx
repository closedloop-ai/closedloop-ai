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
export function AgentDetailWithPromote({ slug }: { slug: string }) {
  const { membership } = useOrganization();
  const isAdmin = isAdminRole(membership?.role);

  return (
    <AgentDetail
      analytics={() => <TokenTrendSection slug={slug} />}
      headerAction={
        isAdmin
          ? (component) =>
              // FEA-3048: observable-only kinds (built-in Tool/Config) are not
              // distributable — hide Promote even for admins (the server-side
              // guard in agent-components/promote rejects them regardless).
              isPromotableKind(component.kind) ? (
                <PromoteHeaderAction component={component} />
              ) : null
          : undefined
      }
      slug={slug}
    />
  );
}

/**
 * Web-only "Token trend by model" section. Rendered via the shared
 * {@link AgentDetail} `analytics` slot so the HTTP-backed {@link TokenTrendChart}
 * (GET /agent-components/{slug}/token-trend) mounts only on web, never on the
 * desktop shell whose inert REST adapter always rejects.
 */
function TokenTrendSection({ slug }: { slug: string }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="font-semibold text-lg tracking-tight">
        Token trend by model
      </h3>
      <p className="text-muted-foreground text-sm">
        Total tokens (input + output) per model over time, bucketed by session
        start day.
      </p>
      <TokenTrendChart slug={slug} />
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
