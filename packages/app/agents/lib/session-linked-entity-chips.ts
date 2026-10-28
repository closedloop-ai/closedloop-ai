import type {
  AgentSessionListItem,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";

/**
 * FEA-4210: one display-ready chip in the Sessions `Linked issues` cell
 * (`SessionLinkedChipsCell`). `Owning project` rendered these too until
 * ISS-12454 made it an editable picker.
 *
 * Display-ready on purpose: the presentational table receives
 * `SessionTableRow`s, not raw session records, so the resolution happens before
 * the cell and the cell owns only the fit, overflow and accessible-name rules.
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
 * Test hook for the linked-ISSUES overflow control, the only linked-entity
 * column that still renders chips (ISS-12454 made `Owning project` an editable
 * control).
 *
 * An exported constant rather than a literal retyped at each site: the same
 * string is needed by the production cell, its story, and its test, and this
 * package has already been through that review once —
 * `synced-sessions-table.test-helpers.tsx` re-exports the production
 * `SESSION_STATUS_SYNC_BADGE_TEST_ID` with the note "never retyped (PR review)".
 * A hand-typed copy in the test is what lets a renamed production hook leave the
 * test silently matching nothing.
 */
export const SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID =
  "session-linked-issues-overflow" as const;

/**
 * Test hook for the chips TRACK itself — the flex row the chips sit in, as
 * against the `+N` control inside it.
 *
 * Derived from the column's overflow id rather than declared as a second
 * constant, so a renamed column cannot leave the two hooks naming different
 * columns. Needed because the capped (grid) and uncapped (card) tracks differ
 * ONLY in their layout rules — one clips to a single line and hands the rest to
 * `+N`, the other wraps because it has no `+N` to hand anything to — and jsdom
 * has no layout, so the rules themselves are the only falsifiable evidence.
 */
export function sessionLinkedChipsTrackTestId(overflowTestId: string): string {
  return `${overflowTestId}-track`;
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
 * calls an issue: `TYPE_ROUTE_PREFIX` routes a FEATURE to `/documents/{slug}`, and
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
