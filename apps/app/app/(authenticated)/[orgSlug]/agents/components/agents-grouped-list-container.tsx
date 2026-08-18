"use client";

/**
 * Thin client wrapper for the web Agents workspace list.
 *
 * Kept as a separate client component so that agents/page.tsx remains a
 * Server Component (able to export Next.js `metadata`).
 *
 * Rows navigate to the per-component detail route (`/{org}/agents/{slug}`) via
 * the component's org-identity `slug` — NOT its `id` (the DB UUID). The detail
 * endpoint (`GET /agent-components/{slug}`) resolves by that identity slug.
 *
 * FEA-4098 (Slice 3): the Owner column (and its GitHub-connection-driven
 * Connect-GitHub CTA, FEA-2923) was removed — authorship is now the
 * `collaborators` people-set derived server-side from the DefinitionVersion
 * lineage, which needs no GitHub connection — so this wrapper no longer resolves
 * or threads any GitHub connection state.
 *
 * FEA-4085 (merged from main): the web adapter does NOT mount the Packs
 * distribution catalog under the Plugins tab — it passes no `pluginsFooter`, so
 * the web Plugins tab shows only the installed inventory. (The Packs workspace
 * remains a desktop-panel surface.)
 */

import { AgentsGroupedList } from "@repo/app/agents/components/workspace/agents-grouped-list";
import { useOrgSlug } from "@/hooks/use-org-slug";

export function AgentsGroupedListContainer() {
  const orgSlug = useOrgSlug();

  return (
    <AgentsGroupedList
      getComponentHref={(item) =>
        `/${orgSlug}/agents/${encodeURIComponent(item.slug)}`
      }
      persistKey="agents:web"
    />
  );
}
