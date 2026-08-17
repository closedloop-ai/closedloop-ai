import type { BranchLinkedArtifact } from "@repo/api/src/types/branch";
import { buildSlugPrefixAlternation } from "@repo/api/src/types/slug-prefix";

/**
 * Closedloop slug embedded in a branch name, case-insensitive (branch names are
 * lowercase like "fea-3457-..."); the captured slug is uppercased to canonical.
 * The digit run is unbounded, matching `artifact-ref-extractor`: a width cap would
 * silently stop recognizing a branch's slug once numbering crosses it.
 *
 * FEA-4137: the accepted prefix alphabet (incl. `ISS`, so an `iss-123-*` branch
 * keeps its linked-Issue chip, alongside the `fea-*` compat alias) is driven
 * from the REFERENCEABLE_SLUG_PREFIXES SSOT shared with the artifact-ref
 * extractor and the sync-schema validator, so the branch-slug alphabet can never
 * drift between cloud and Desktop.
 */
const BRANCH_NAME_SLUG_RE = new RegExp(
  String.raw`\b(${buildSlugPrefixAlternation()})-(\d+)\b`,
  "gi"
);

/**
 * Derive the branch's linked artifacts from its NAME — the only reliable
 * branch→artifact signal (e.g. "fea-1952-branches-epic-f" → [{ slug: "FEA-1952" }]).
 *
 * The single SSOT shared by the desktop producer
 * (apps/desktop/src/main/branch/shared-branches-api.ts) and the cloud read-service
 * (apps/api/app/branches/branch-read-service.ts), so the FEA/PLN/PRD chips render
 * identically on web/cloud and desktop and the slug alphabet can never drift
 * between the two surfaces (FEA-3457).
 *
 * Deliberately NOT derived from session-transcript references: those are
 * incidental prose/URL/tool mentions captured by the artifact-ref extractor, and
 * aggregating them across a branch's sessions yields a long, noisy list of
 * artifacts the branch never delivered. Deduped, order-preserving.
 */
export function deriveLinkedArtifactsFromBranchName(
  branchName: string
): BranchLinkedArtifact[] {
  const seen = new Set<string>();
  const artifacts: BranchLinkedArtifact[] = [];
  for (const match of branchName.matchAll(BRANCH_NAME_SLUG_RE)) {
    const slug = `${match[1].toUpperCase()}-${match[2]}`;
    if (!seen.has(slug)) {
      seen.add(slug);
      artifacts.push({ slug });
    }
  }
  return artifacts;
}
