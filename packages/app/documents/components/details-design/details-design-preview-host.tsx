"use client";

// Cross-slice on purpose: the Details harness needs the PR pill's canonical
// GitHub href builder, which the agents slice owns.
import { getPullRequestHref } from "@repo/app/agents/components/detail/session-pull-request-pill";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import {
  getRouteForSlug,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import type {
  DetailsDesignHost,
  DetailsPriorityEditorProps,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { DetailsDesignPreview } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-preview";
import { ArtifactPriorityVariant } from "@repo/app/shared/lib/artifact-priority-ownership";
import { SessionCostCell } from "./details-design-session-cells";

/**
 * ISS-10792 design-review harness host. `shared/` may not import a feature
 * slice, so the canonical priority control and href builders are supplied
 * here, as a production Details host would supply them. Deleted with the
 * harness once the approved layout is built.
 */

const FIXTURE_ORG_SLUG = "fixture-org";

export const DETAILS_DESIGN_HOST: DetailsDesignHost = {
  artifact: (slug) => withOrgSlug(FIXTURE_ORG_SLUG, getRouteForSlug(slug)),
  // No shared builder exists; this is the web shell's own pattern
  // (`apps/app/.../sessions/[id]/page.tsx` `getBranchHref`).
  branch: (branchId) => `/${FIXTURE_ORG_SLUG}/branches/${branchId}`,
  pullRequest: (num, repositoryFullName) =>
    getPullRequestHref({ num, status: "", title: "" }, repositoryFullName),
  sessionCost: () => <SessionCostCell />,
};

export function DetailsPriorityEditorHost({
  mutationActivity,
  onSelect,
  priority,
  support,
}: DetailsPriorityEditorProps) {
  return (
    <ArtifactPriorityEditor
      className="-mx-1 rounded px-1"
      mutationActivity={mutationActivity}
      onSelect={onSelect}
      priority={priority}
      support={support}
      variant={ArtifactPriorityVariant.DetailField}
    />
  );
}

export function DetailsDesignPreviewHost() {
  return (
    <DetailsDesignPreview
      host={DETAILS_DESIGN_HOST}
      priorityEditor={DetailsPriorityEditorHost}
    />
  );
}
