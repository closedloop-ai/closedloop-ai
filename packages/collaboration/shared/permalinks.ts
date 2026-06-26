const TRAILING_SLASH_RE = /\/$/;

/** Builds `<origin><artifactPath>?thread=<threadId>` for a comment permalink. */
export function buildCommentPermalink({
  origin,
  artifactPath,
  threadId,
}: {
  origin: string;
  artifactPath: string;
  threadId: string;
}): string {
  const trimmedOrigin = origin.replace(TRAILING_SLASH_RE, "");
  const normalizedPath = artifactPath.startsWith("/")
    ? artifactPath
    : `/${artifactPath}`;
  const trimmedPath = normalizedPath.replace(TRAILING_SLASH_RE, "");
  return `${trimmedOrigin}${trimmedPath}?thread=${encodeURIComponent(threadId)}`;
}
