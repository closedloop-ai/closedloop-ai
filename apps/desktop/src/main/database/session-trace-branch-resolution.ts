/**
 * @file session-trace-branch-resolution.ts
 * @description Which BRANCH a session delivered on, resolved from its artifact
 * links. Extracted from `session-trace.ts` (ISS-7830), which is over the size
 * ceiling and shrink-only.
 *
 * A distinct responsibility from building trace sync fields — it reads
 * `session_artifact_links`, not the trace — and it already had its own named
 * suite (`test/session-trace-branch-resolution.test.ts`) before it had its own
 * module. Both consumers (`session-trace.ts` and `sync-source.ts`) import it from
 * here.
 */

import { BRANCH_WRITE_METHOD_VALUES } from "./db-constants.js";
import type { SqliteArtifactLinkRow } from "./db-row-types.js";

// Write evidence only — a read-only session resolves to no branch.
const BRANCH_WRITE_METHODS: ReadonlySet<string> = new Set(
  BRANCH_WRITE_METHOD_VALUES
);

export function resolveArtifactLinkBranch(
  linkRows: SqliteArtifactLinkRow[]
): string | null {
  let best: SqliteArtifactLinkRow | null = null;
  for (const link of linkRows) {
    if (link.target_kind !== "branch" || !link.branch_name) {
      continue;
    }
    if (!BRANCH_WRITE_METHODS.has(link.method)) {
      continue;
    }
    const observedAt = Date.parse(link.link_observed_at ?? "");
    const bestObservedAt = Date.parse(best?.link_observed_at ?? "");
    if (
      !best ||
      (Number.isFinite(observedAt) &&
        (!Number.isFinite(bestObservedAt) || observedAt > bestObservedAt))
    ) {
      best = link;
    }
  }
  return best?.branch_name ?? null;
}
