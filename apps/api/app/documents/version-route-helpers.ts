import {
  type DocumentVersion,
  isValidVersionNumber,
} from "@repo/api/src/types/document-version";
import type { NextRequest } from "next/server";
import { badRequestResponse } from "@/lib/route-utils";
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

/**
 * Resolves the `?version=` query parameter shared by the id and by-slug
 * artifact GET routes. A malformed value is a client error, so it returns a
 * 400 rather than the 500 an `errorResponse` would produce.
 */
export function parseVersionParam(request: NextRequest): ParsedVersionParam {
  const versionParam = request.nextUrl.searchParams.get("version");
  // An empty `?version=` fell through to the latest version before this helper
  // existed; keeping that keeps the tightening to genuinely malformed values.
  if (versionParam === null || versionParam === "") {
    return { ok: true, versionParam: null, versionNumber: undefined };
  }

  const versionNumber = Number(versionParam);
  if (!isValidVersionNumber(versionNumber)) {
    return {
      ok: false,
      response: badRequestResponse("Version must be a positive integer"),
    };
  }

  return { ok: true, versionParam, versionNumber };
}

type ParsedVersionParam =
  | {
      ok: true;
      versionParam: string | null;
      versionNumber: number | undefined;
    }
  | { ok: false; response: ReturnType<typeof badRequestResponse> };
