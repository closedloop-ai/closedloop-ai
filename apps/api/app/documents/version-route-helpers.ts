import type { DocumentVersion } from "@repo/api/src/types/document-version";
import { documentVersionService } from "./document-version-service";

type DocumentLatestVersionArtifact = {
  id: string;
  latestVersion: number;
};

/**
 * Returns the latest document version content for GET route responses while
 * preserving a missing latest-version row as a distinct not-found outcome.
 */
export async function resolveLatestVersionContent(
  artifact: DocumentLatestVersionArtifact,
  version: DocumentVersion
): Promise<{ latestVersionContent: string | null } | null> {
  const latestVersion =
    version.version === artifact.latestVersion
      ? version
      : await documentVersionService.getLatest(artifact.id);

  if (!latestVersion) {
    return null;
  }

  return { latestVersionContent: latestVersion.content };
}
