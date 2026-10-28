"use client";

/**
 * The WEB host of the Agents inventory route (ISS-9398).
 *
 * Kept as a separate client component so `agents/page.tsx` stays a Server
 * Component able to export Next.js `metadata`.
 *
 * WHAT THIS FILE IS ALLOWED TO DECIDE, and it is now only two things: the ROUTE
 * a row links to (`/{org}/agents/{slug}` — the identity slug the detail endpoint
 * resolves by, never the DB uuid) and the view-state persistence key. Both are
 * host-boundary seams (`HostBoundarySeam.Routing`, plus the shell's own storage
 * namespace). It used to be an app-local presentation wrapper around the shared
 * list; PRD-730 replaces that with a thin adapter, and ISS-9216 is why —
 * anything a host composes is something the two shells can compose differently.
 *
 * ONE flag read, HERE, choosing between two whole shapes. Neither branch knows
 * the gate exists (`AGENTS.md` -> Code Style, "One read site per feature flag").
 * The same PostHog key gates the desktop renderer, which resolves the signed-in
 * account's assignment from the same key space, so there is no second key.
 *
 * FEA-4098 (Slice 3): no Owner column and so no GitHub-connection state to
 * resolve — authorship is the `collaborators` people-set derived server-side
 * from the DefinitionVersion lineage.
 *
 * FEA-4085: web mounts no plugin-management bridge on either branch. It has no
 * local pack runtime, and the honest answer is an absent affordance rather than
 * a disabled one; org pack distribution is the sibling Packs route.
 */

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import { AgentsGroupedList } from "@repo/app/agents/components/workspace/agents-grouped-list";
import { AgentsListSurfaceV2 } from "@repo/app/agents/components/workspace/agents-list-surface-v2";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useOrgSlug } from "@/hooks/use-org-slug";

/** The web shell's `localStorage` namespace for this route's view state. */
const WEB_AGENTS_PERSIST_KEY = "agents:web";

export function AgentsListHost() {
  const orgSlug = useOrgSlug();
  const completeSurfaceEnabled = useFeatureFlagEnabled(
    AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY
  );

  const getComponentHref = (item: AgentComponent) =>
    `/${orgSlug}/agents/${encodeURIComponent(item.slug)}`;

  if (completeSurfaceEnabled) {
    return (
      <AgentsListSurfaceV2
        getComponentHref={getComponentHref}
        persistKey={WEB_AGENTS_PERSIST_KEY}
      />
    );
  }

  return (
    <AgentsGroupedList
      getComponentHref={getComponentHref}
      persistKey={WEB_AGENTS_PERSIST_KEY}
    />
  );
}
