import { Result } from "@repo/api/src/types/result";
import { SeedVersionMode } from "@repo/realtime-contract/doc-sync-internal";
import { publishVersionToLiveDocument } from "@/app/doc-sync/internal/seed-state";
import { documentService } from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";

export type LiveDraftReset = { applied: boolean; stale: boolean };

/** A confirmed reset and the version the draft was reset to (ISS-12552). */
export type LiveDraftResetResult = { reset: LiveDraftReset; version: number };

export const LiveDraftResetError = {
  DocumentNotFound: "document_not_found",
  VersionNotFound: "version_not_found",
  SeedFailed: "seed_failed",
} as const;
export type LiveDraftResetError =
  (typeof LiveDraftResetError)[keyof typeof LiveDraftResetError];

export const liveDraftService = {
  /**
   * PLN-2190 T-3.2: resets the document's live doc-sync draft to its latest
   * version (Restore Version on the latest version). Creates no version and
   * sends no signal: the change reaches open editors as a Yjs sync.
   */
  async resetToLatest(
    documentId: string,
    organizationId: string
  ): Promise<Result<LiveDraftResetResult, LiveDraftResetError>> {
    const document = await documentService.findByIdSimple(
      documentId,
      organizationId
    );
    if (!document) {
      return Result.err(LiveDraftResetError.DocumentNotFound);
    }
    const latest = await documentVersionService.getLatest(documentId);
    if (!latest) {
      return Result.err(LiveDraftResetError.VersionNotFound);
    }
    const seeded = await publishVersionToLiveDocument({
      document,
      // As the editor reads a version with no content (`version.content ?? ""`).
      content: latest.content ?? "",
      version: latest.version,
      mode: SeedVersionMode.Reset,
    });
    if (!seeded.ok) {
      return Result.err(LiveDraftResetError.SeedFailed);
    }
    return Result.ok({
      reset: { applied: seeded.value.applied, stale: seeded.value.stale },
      version: latest.version,
    });
  },
};
