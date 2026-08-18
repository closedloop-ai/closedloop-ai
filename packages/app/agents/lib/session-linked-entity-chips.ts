import type {
  AgentSessionListItem,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";

/**
 * FEA-4209 / FEA-4210: one display-ready chip in a Sessions-row LINKED-ENTITY
 * cell — the `Owning project` column and the `Linked issues` column both render a
 * list of these through the same cell (`SessionLinkedChipsCell`).
 *
 * Display-ready on purpose. The presentational table receives
 * `SessionTableRow`s, not raw session records, and the two columns differ only
 * in what they resolve and whether the chip carries an icon — so the shared
 * shape is what stops the second column from growing its own copy of the fit,
 * overflow, and accessible-name rules.
 */
export type SessionLinkedEntityChip = Readonly<{
  /** Stable React key AND the dedupe identity — the linked entity's id. */
  key: string;
  /** The visible chip text (an issue slug, a project name). */
  label: string;
  /**
   * Destination, or `null` when this build cannot resolve one. A null href
   * renders an INERT chip that still names the entity, rather than a dead link
   * — the same degradation `SessionLinkedArtifactsRow` already makes on the
   * session-detail surface for a slug-less or non-navigable artifact.
   */
  href: string | null;
  /**
   * Fuller description for the chip's tooltip and accessible name (an issue
   * title, the project name). `null` when there is nothing to add beyond
   * {@link label}, so the cell can skip the tooltip rather than repeat itself.
   */
  title: string | null;
}>;

/**
 * Test hooks for the two linked-entity overflow controls.
 *
 * Exported constants rather than literals retyped at each site: the same string
 * is needed by the production cell, its story, and its test, and this package
 * has already been through that review once —
 * `synced-sessions-table.test-helpers.tsx` re-exports the production
 * `SESSION_STATUS_SYNC_BADGE_TEST_ID` with the note "never retyped (PR review)".
 * A hand-typed copy in the test is what lets a renamed production hook leave the
 * test silently matching nothing.
 */
export const SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID =
  "session-linked-issues-overflow" as const;

/** @see SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID */
export const SESSION_LINKED_PROJECTS_OVERFLOW_TEST_ID =
  "session-linked-projects-overflow" as const;

/**
 * Test hook for the chips TRACK itself — the flex row the chips sit in, as
 * against the `+N` control inside it.
 *
 * Derived from the column's overflow id rather than declared as a second pair of
 * constants, so a renamed column cannot leave the two hooks naming different
 * columns. Needed because the capped (grid) and uncapped (card) tracks differ
 * ONLY in their layout rules — one clips to a single line and hands the rest to
 * `+N`, the other wraps because it has no `+N` to hand anything to — and jsdom
 * has no layout, so the rules themselves are the only falsifiable evidence.
 */
export function sessionLinkedChipsTrackTestId(overflowTestId: string): string {
  return `${overflowTestId}-track`;
}

/**
 * FEA-4209: the session's linked PROJECT(s), as chips.
 *
 * The cloud contract carries at most ONE project per session
 * (`AgentSessionListItem.project`, resolved server-side by
 * `project-resolution.ts` from the session's source artifact or loop), so today
 * this returns 0 or 1 chip. It returns a LIST anyway because the column is
 * rendered by the shared multi-chip cell that the `Linked issues` column also
 * uses: one fit rule, one `+N` overflow, one accessible name. That is reuse of a
 * cell the other column exercises, not speculative machinery for a cardinality
 * this contract does not have — see the ticket comment on FEA-4209.
 *
 * No href: the project detail page is routed at
 * `/{orgSlug}/teams/{teamId}/projects/{projectId}`, and `teamId` is not on
 * `AgentSessionProjectSummary` (`{id, name, slug}`). Linking would require a
 * contract addition, so the chip names the project and stays inert rather than
 * guessing a route.
 */
export function resolveSessionProjectChips(
  item: AgentSessionListItem
): readonly SessionLinkedEntityChip[] {
  const project = item.project;
  if (!project) {
    return [];
  }
  const label = project.name.trim();
  if (label.length === 0) {
    return [];
  }
  return [{ key: project.id, label, href: null, title: null }];
}

/**
 * FEA-4210: the session's linked ISSUES, as chips.
 *
 * Source is the EXISTING `linkedArtifacts` projection — the session→document
 * `ArtifactLink`s that `artifact-links/slug-links.ts` already ingests from the
 * transcript's `closedloop_artifact` refs. The ticket's open question ("explicit
 * slug references vs. derived via the linked branch/PR's issue") is answered by
 * taking the explicit references that exist; no branch/PR-derived inference is
 * added here.
 *
 * Filtered to {@link DocumentType.Feature} because that is what this product
 * calls an issue: `TYPE_ROUTE_PREFIX` routes a FEATURE to `/issues/{slug}`, and
 * `getDocumentTypeLabel` names it "Issue". A PRD or plan riding in a column
 * headed "Linked issues" would be a mislabel, so the other document types this
 * projection carries are deliberately dropped rather than relabelled.
 *
 * Deduped by artifact id: the same artifact can be linked more than once
 * (different `role`/`method` on separate refs), and a repeated chip reads as two
 * issues.
 *
 * `buildHref` is the surface's route builder (web joins the org slug onto
 * `getDocumentTypeRoute`; a host that cannot resolve one omits it). An absent
 * builder — or a builder that returns `null` for a slug-less artifact — yields
 * an inert chip, never a dead link.
 */
export function resolveSessionIssueChips(
  item: AgentSessionListItem,
  buildHref?: (artifact: SessionLinkedArtifact) => string | null
): readonly SessionLinkedEntityChip[] {
  const chips: SessionLinkedEntityChip[] = [];
  const seen = new Set<string>();
  for (const artifact of item.linkedArtifacts ?? []) {
    if (
      artifact.documentType !== DocumentType.Feature ||
      seen.has(artifact.id)
    ) {
      continue;
    }
    const label = artifact.slug ?? artifact.name;
    if (!label) {
      continue;
    }
    seen.add(artifact.id);
    chips.push({
      key: artifact.id,
      label,
      href: buildHref?.(artifact) ?? null,
      // Only when it adds something: `name` equal to the slug would make the
      // tooltip repeat the chip it is describing.
      title: artifact.name && artifact.name !== label ? artifact.name : null,
    });
  }
  return chips;
}
