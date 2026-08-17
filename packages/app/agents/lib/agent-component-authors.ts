import type { AgentComponent } from "@repo/api/src/types/agent-component";

/**
 * FEA-4247: derive the authors people-set to RENDER for an agentic component.
 *
 * Authorship on the wire has two axes, in precedence order:
 *  1. `collaborators` — the canonical authors people-set (FEA-4098): the
 *     `DefinitionVersionEditor` lineage (discoverer + editors), with the
 *     server-side compute-target owner fallback layered in for legacy/unlinked
 *     rows (also FEA-4247). This is what a current server emits.
 *  2. `owner` — the DEPRECATED single-owner compat alias a version-skewed
 *     server (older cloud, or a desktop/relay peer that predates the
 *     `collaborators` axis) may still send instead.
 *
 * FEA-4098 replaced the single git-attributed `owner` with `collaborators` but
 * left rows with no recorded authors rendering a blank Owner. The server fix
 * (FEA-4247) repopulates `collaborators`; this client derivation is the
 * skew-safe counterpart so the surface still shows an author when a peer only
 * sent the legacy `owner`. It never fabricates an author: when neither axis has
 * data it returns an empty array, which `CollaboratorStack` renders as an
 * honest em dash.
 */
export function resolveComponentAuthors(
  // `collaborators` is typed required on `AgentComponent`, but this is the
  // skew-safe path for an OLDER producer that predates the axis and sends only
  // `owner` — such a payload omits `collaborators` entirely, so it must be
  // modelled optional here or `.length` throws before `owner` is ever read.
  component: Pick<AgentComponent, "owner"> & {
    collaborators?: readonly string[];
  }
): readonly string[] {
  if (component.collaborators && component.collaborators.length > 0) {
    return component.collaborators;
  }
  return component.owner ? [component.owner] : [];
}

/**
 * FEA-4266 — canonical user-visible label for the authorship people-set
 * (discoverer + editors), formerly shown as "Collaborators". With FEA-4247's
 * read-time owner fallback the common case is a single person, so the plural
 * "Collaborators" over one avatar read wrong; every surface (detail PropRow,
 * table column header, group-by menu, filter facet, grouped-list summary)
 * derives its label from this single constant. The internal enum member
 * {@link AgentComponentGroupBy.Collaborators}, its `"collaborators"` state
 * value, and the `"collaborators"` column id are unchanged (persisted-view /
 * localStorage keys, not user-visible URLs) so saved views keep loading.
 *
 * Lives in the agents slice, not `@repo/api`: it is presentation copy consumed
 * only by `packages/app/agents`, and `packages/api` is scoped to transport
 * contracts and cross-process constants (packages/api/AGENTS.md).
 */
export const AGENT_COMPONENT_AUTHORS_LABEL = "Authors" as const;

/**
 * FEA-4266 — trailing empty-bucket label for the group-by-{@link
 * AGENT_COMPONENT_AUTHORS_LABEL} grouping: components with no attributed
 * authors land here. Kept beside the label so the two never drift.
 */
export const AGENT_COMPONENT_NO_AUTHORS_LABEL = "No authors" as const;
