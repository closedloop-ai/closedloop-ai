"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { useMemo } from "react";
import { useProjects } from "../../projects/hooks/use-projects";
import type { SessionProjectNameResolver } from "../lib/session-active-filter-chips";

/**
 * ISS-5355 — resolve a Sessions Project display name for a project the ACTIVE
 * DATE WINDOW cannot name.
 *
 * Project labels come from the usage `byProject` breakdown, which only contains
 * projects with at least one session inside the selected window. A project whose
 * sessions all fall outside it — the ordinary case for a link arriving from the
 * project-detail strip, which counts over an unbounded window — has no usage
 * row, so the facet option and its chip fell back to the raw uuid and rendered
 * `Project: 019f8008-19…`, truncated to something no reader can identify or act
 * on. Project was the only facet doing this: Owner resolves off the org roster
 * (ISS-4974), Repository shortens the full name, Model's value IS its label.
 *
 * The org project list is the one source that is not window-scoped, so it is
 * what closes the gap. The same two rules the Owner resolver enforces apply:
 *
 * 1. **Never fabricate.** Returns `undefined` for an id no org project carries
 *    (a deleted project, an unreachable list), so the caller falls back to the
 *    raw id rather than this hook inventing a name.
 * 2. **Never fetch reflexively.** Gated on there actually being a selected
 *    project id ON SCREEN that the usage summary cannot name, so the default
 *    Sessions view issues no project request at all.
 */
export function useSessionProjectNameResolver({
  usage,
  selectedProjectIds,
  enabled = true,
}: {
  usage: AgentSessionUsageSummary | undefined;
  /** The Project facet's currently-selected project ids. */
  selectedProjectIds: readonly string[];
  /**
   * Whether the Project facet exists on this surface at all. Off on any host
   * that does not offer the facet, so no roster read can be issued for a
   * dimension the surface cannot filter by.
   */
  enabled?: boolean;
}): SessionProjectNameResolver | undefined {
  const hasUnresolvedProject = useMemo(() => {
    const namedInWindow = new Set(
      (usage?.byProject ?? []).map((entry) => entry.projectId)
    );
    return selectedProjectIds.some(
      (projectId) => !namedInWindow.has(projectId)
    );
  }, [usage, selectedProjectIds]);

  const { data: projects } = useProjects(undefined, {
    enabled: enabled && hasUnresolvedProject,
  });

  return useMemo(() => {
    if (!projects) {
      return;
    }
    const nameById = new Map<string, string>();
    for (const project of projects) {
      const name = project.name.trim();
      if (name) {
        nameById.set(project.id, name);
      }
    }
    return (projectId: string) => nameById.get(projectId);
  }, [projects]);
}
