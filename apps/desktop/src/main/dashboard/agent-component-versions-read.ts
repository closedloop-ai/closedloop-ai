/**
 * @file agent-component-versions-read.ts
 * @description The desktop-local content-hash version-history read: one
 * component family's `agent_component_versions` rows, adapted into the shared
 * cross-surface `ComponentVersion` DTO.
 *
 * Split out of `shared-agent-components-api.ts` (a grandfathered, shrink-only
 * over-ceiling file) when ISS-6232 gave the read a provenance argument. It is
 * one cohesive responsibility — "what revisions does this component have, and
 * what source did each come from" — and its cloud twin already lives in its own
 * module (`apps/api/app/agent-components/service/detail-version-history.ts`),
 * so the two now sit at the same level of the import graph.
 */

import {
  buildComponentVersions,
  type ComponentVersion,
} from "@repo/api/src/types/agent-component";
import type { ComponentSourceProvenance } from "@repo/api/src/types/component-source";
import type { DbHostPrisma } from "../database/prisma-client.js";

/** One retained revision row, as SQLite returns it. */
type VersionRow = {
  source: string | null;
  content_hash: string;
  content: string;
  format: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

/**
 * Read the content-hash version history for a component, newest-first. The
 * current revision is the one whose hash matches the live inventory
 * `content_hash` (falls back to the newest row when the current hash is
 * unknown).
 *
 * ISS-6232: `provenance` is the family's provenance folded across every
 * inventory row (representative first). Every stored revision carries the
 * collector's `""` source sentinel — that column participates in the version
 * identity `(kind, key, source, hash)`, so it is resolved at READ time rather
 * than rewritten, which would fork every retained revision. The shared
 * `buildComponentVersions` applies the same derivation the cloud detail read
 * applies to the same columns, so the two surfaces cannot answer differently.
 */
export async function readComponentVersions(
  prisma: Pick<DbHostPrisma, "client">,
  kind: string,
  key: string | null,
  currentHash: string | null,
  provenance: ComponentSourceProvenance
): Promise<ComponentVersion[]> {
  const normKey = (key ?? "").toLowerCase().trim();
  const rows = await prisma.client.$queryRawUnsafe<VersionRow[]>(
    `SELECT source, content_hash, content, format, first_seen_at, last_seen_at
       FROM agent_component_versions
      WHERE component_kind = ?
        AND lower(trim(component_key)) = ?
      ORDER BY last_seen_at DESC, first_seen_at DESC`,
    kind,
    normKey
  );
  // Adapt SQLite rows into the surface-neutral shape (resolving createdAt from
  // first_seen_at, falling back to last_seen_at) and defer the isCurrent /
  // newest-fallback mapping to the shared `buildComponentVersions` (SSOT with
  // the cloud reader).
  return buildComponentVersions(
    rows.map((r) => ({
      contentHash: r.content_hash,
      source: r.source,
      format: r.format,
      createdAt: r.first_seen_at ?? r.last_seen_at ?? "",
      content: r.content,
    })),
    currentHash,
    provenance
  );
}
