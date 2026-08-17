/**
 * Evergreen-Document enrichment for the loop context pack (FEA-3951).
 *
 * A human attaches an evergreen Document (`DocumentType.Doc`) to a FEAT/PRD in
 * the Context section of the detail page; that creates a `RelatesTo` link with
 * the Document as the source and the FEAT/PRD as the target. This module
 * resolves those links and folds each referenced Document's latest content into
 * the context pack so long-term strategy/branding/context docs inform every
 * context surface the FEAT/PRD already drives (plan/loop generation).
 *
 * Split out of loop-context-pack.ts to keep that module under the line ceiling.
 */

import type { ContextPack } from "@closedloop-ai/loops-api/context-pack";
import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { log } from "@repo/observability/log";
import type { LimitFunction } from "p-limit";
import { artifactLinksService } from "@/app/artifact-links/service";
import { documentService } from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import type { LoopForContextPack } from "./loop-context-pack-types";
import {
  shouldWrapLoopArtifactContent,
  wrapUntrustedLoopArtifactContent,
} from "./untrusted-loop-input";

// Bound the number of referenced evergreen Documents folded into a single
// context pack. `RelatesTo` links are human-attached in the FEAT/PRD detail UI,
// so the realistic count is small, but each linked doc costs two pooled reads
// (the artifact + its latest version) so we cap the fan-out defensively.
const MAX_LINKED_EVERGREEN_DOCS = 20;

// Bound the aggregate serialized bytes of folded-in evergreen Document bodies.
// The count cap alone does not bound payload size, and a single valid document
// version can be ~1 MB — enough to push an unsigned inline CloudRelay dispatch
// past its 1 MB body limit and fail the launch before Desktop ever sees it
// (wongk review). Drop docs once the running total would exceed this budget so
// the loop still launches with the artifacts that fit; larger context should go
// through the S3 context-pack path, not the inline body.
const MAX_LINKED_EVERGREEN_DOCS_TOTAL_BYTES = 512 * 1024;

/**
 * Fetch evergreen Documents (`DocumentType.Doc`) referenced by the loop's
 * primary artifact via `LinkType.RelatesTo` links (FEA-3951).
 *
 * Only `DocumentType.Doc` sources are folded in here: PRD context refs travel
 * the loop's `contextRefs` path, and other link types (`Produces`, `Blocks`)
 * carry lineage/blocking semantics rather than "additional context".
 */
export async function fetchLinkedEvergreenDocs(
  loop: LoopForContextPack,
  organizationId: string,
  limiter?: LimitFunction
): Promise<ContextPack["artifacts"]> {
  if (!loop.documentId) {
    return [];
  }

  // This enrichment is on the launch-critical Promise.all path in
  // buildContextPackInMemory. Per apps/api/lib/loops/AGENTS.md, a best-effort
  // metadata lookup that only *adds* context must never fail the loop: catch
  // every lookup failure (the link list read and each per-doc read), log a
  // warning, and degrade to an omitted value ([]) instead of rejecting.
  try {
    return await resolveLinkedEvergreenDocs(loop, organizationId, limiter);
  } catch (error) {
    log.warn(
      "[loop-context-pack] Failed to resolve linked evergreen Documents; omitting from context pack",
      {
        loopId: loop.id,
        documentId: loop.documentId,
        error,
      }
    );
    return [];
  }
}

async function resolveLinkedEvergreenDocs(
  loop: LoopForContextPack,
  organizationId: string,
  limiter?: LimitFunction
): Promise<ContextPack["artifacts"]> {
  const documentId = loop.documentId;
  if (!documentId) {
    return [];
  }

  const links = await artifactLinksService.findSourceLinks(
    organizationId,
    documentId,
    LinkType.RelatesTo
  );
  if (links.length === 0) {
    return [];
  }

  // Distinct source ids — a doc referenced twice contributes once. We do NOT
  // cap here: `RelatesTo` links carry mixed source types (session->artifact
  // links use the same type), and capping by raw link order before filtering to
  // DOC sources can drop real evergreen Documents behind newer non-DOC links
  // (codex/wongk review). Resolve each source, keep only DOC-typed artifacts,
  // THEN apply the cap to the resulting docs.
  const sourceIds = [...new Set(links.map((link) => link.sourceId))];

  const results = await mapWithDbConcurrency(
    sourceIds,
    (sourceId) => fetchEvergreenDocArtifact(sourceId, organizationId, loop.id),
    limiter
  );

  const docs = results.filter((item): item is NonNullable<typeof item> =>
    Boolean(item)
  );
  return applyEvergreenDocByteBudget(
    docs.slice(0, MAX_LINKED_EVERGREEN_DOCS),
    loop.id
  );
}

// Enforce the aggregate serialized-byte budget over the resolved evergreen docs
// (wongk review). Keeps docs in order until the running total would exceed the
// budget, then drops the rest and warns — so an oversized linked Document cannot
// balloon the inline dispatch body and fail the launch.
function applyEvergreenDocByteBudget(
  docs: ContextPack["artifacts"],
  loopId: string
): ContextPack["artifacts"] {
  const kept: ContextPack["artifacts"] = [];
  let totalBytes = 0;

  for (const doc of docs) {
    const docBytes = Buffer.byteLength(doc.content, "utf8");
    if (totalBytes + docBytes > MAX_LINKED_EVERGREEN_DOCS_TOTAL_BYTES) {
      log.warn(
        "[loop-context-pack] Linked evergreen Document byte budget reached, dropping remaining",
        {
          loopId,
          droppedDocumentId: doc.id,
          docBytes,
          totalBytes,
          limitBytes: MAX_LINKED_EVERGREEN_DOCS_TOTAL_BYTES,
        }
      );
      break;
    }
    kept.push(doc);
    totalBytes += docBytes;
  }

  return kept;
}

async function fetchEvergreenDocArtifact(
  sourceId: string,
  organizationId: string,
  loopId: string
): Promise<ContextPack["artifacts"][number] | null> {
  const artifact = await documentService.findByIdSimple(
    sourceId,
    organizationId
  );
  // Silently skip non-Doc sources (e.g. a PRD relates-to link) — only evergreen
  // Documents are folded in as additional context here.
  if (!artifact || artifact.type !== DocumentType.Doc) {
    return null;
  }

  const latestVersion = await documentVersionService.getLatest(artifact.id);
  const content = latestVersion?.content ?? "";

  log.info("[loop-context-pack] Including referenced evergreen Document", {
    loopId,
    referencedDocumentId: artifact.id,
  });

  return {
    id: artifact.id,
    type: String(artifact.type),
    title: artifact.title,
    content: shouldWrapLoopArtifactContent(String(artifact.type))
      ? wrapUntrustedLoopArtifactContent(content, {
          artifactType: String(artifact.type),
          title: artifact.title,
        })
      : content,
  };
}
