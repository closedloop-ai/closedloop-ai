/**
 * @file seed-closedloop-artifact-link.ts
 * @description ISS-5617: the `kind='closedloop_artifact'` artifact + link rows a
 * SESSION needs before its detail renders a linked-artifact pill.
 *
 * Its caller is `seed-branches-db.ts`, but it lives here rather than there
 * because that module sits ~4 lines under the 1,000-line ceiling
 * (`noExcessiveLinesPerFile`, an `error` for it — it is NOT grandfathered), so
 * folding this in would leave the next seed with nowhere to go. Sibling module
 * per `apps/desktop/test/AGENTS.md`.
 */
import type { MergedUnenrichedBranchSeed } from "./seed-branches-db";

/** One `INSERT` in the FK-ordered batch the caller runs. */
export type SeedBatchItem = {
  sql: string;
  args: Array<string | number>;
};

/**
 * The row shape the live artifact-ref extractor writes, so the app's own
 * projection runs over the seed with no test-only path.
 *
 * The SLUG lives on the `artifacts` row — `session_artifact_links` carries no
 * slug of its own, and `sync-source.ts` reads `a.slug` and `a.kind AS
 * target_kind` through the join. The link carries the detection `method` the
 * canonical `roleFromMethod` maps to the pill's role.
 *
 * `method='slug_in_branch'` with `is_primary=0` is the ordinary
 * branch-name-derived observation and maps to the `workspace` role — the most
 * common real shape, and deliberately NOT `is_primary`, which would
 * short-circuit `roleFromMethod` to `input` and stop the seed exercising the
 * method mapping at all. `title` is left NULL because the local store genuinely
 * has no artifact title to offer, which is what makes the pill label off its
 * slug.
 */
export function closedloopArtifactBatchItems(
  seed: MergedUnenrichedBranchSeed,
  observedAt: string,
  slug: string
): SeedBatchItem[] {
  const artifactId = `artifact-doc-${seed.sessionId}`;
  return [
    {
      sql: `INSERT INTO artifacts
              (id, identity_key, kind, slug, title,
               created_at, last_seen_at, observed_at)
            VALUES (?, ?, 'closedloop_artifact', ?, NULL,
                    ?, ?, ?)`,
      args: [
        artifactId,
        `closedloop_artifact:${slug}`,
        slug,
        observedAt,
        observedAt,
        observedAt,
      ],
    },
    {
      sql: `INSERT INTO session_artifact_links
              (id, session_id, artifact_id, relation, method, evidence,
               is_primary, status, extractor_version, observed_at, created_at)
            VALUES (?, ?, ?, 'referenced', 'slug_in_branch', '{}',
                    0, 'confirmed', 1, ?, ?)`,
      args: [
        `link-doc-${seed.sessionId}`,
        seed.sessionId,
        artifactId,
        observedAt,
        observedAt,
      ],
    },
  ];
}
