import type { DetailTab } from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";

const TRAILING_SLASHES_PATTERN = /\/+$/;

export type ArtifactRouteState = {
  artifactId: string | null;
  createOpen: boolean;
  tab: DetailTab | null;
  commentsOpen: boolean;
  commentId: string | null;
  traceRow: number | null;
  version: string | null;
};

export type ArtifactRouteLocation = {
  basePath?: string;
  pathname?: string;
};

export type ArtifactRouteWriteOptions = {
  basePath?: string;
  routeKey?: string | null;
};

export function readArtifactRouteState(
  search = globalThis.location?.search ?? "",
  location: ArtifactRouteLocation = {}
): ArtifactRouteState {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const traceRowValue = params.get("traceRow");
  const traceRow = traceRowValue === null ? Number.NaN : Number(traceRowValue);
  return {
    artifactId:
      params.get("artifact") ??
      readArtifactRouteKey(
        location.pathname ?? globalThis.location?.pathname ?? "",
        location.basePath
      ),
    createOpen: params.get("create") === "open",
    tab: isDetailTab(tab) ? tab : null,
    commentsOpen: params.get("comments") === "open",
    commentId: params.get("comment"),
    traceRow: Number.isInteger(traceRow) && traceRow >= 0 ? traceRow : null,
    version: params.get("version"),
  };
}

export function writeArtifactRouteState(
  next: Partial<ArtifactRouteState>,
  mode: "push" | "replace" = "replace",
  options: ArtifactRouteWriteOptions = {}
) {
  const url = new URL(globalThis.window.location.href);
  if (options.basePath && next.artifactId !== undefined) {
    url.pathname = next.artifactId
      ? artifactDetailPath(
          options.basePath,
          options.routeKey ?? next.artifactId
        )
      : normalizeBasePath(options.basePath);
    if (!next.artifactId) {
      // Leaving the artifact leaves the project that handed it over, on the
      // same contract `buildArtifactRouteHref` states: the collection must not
      // read as still scoped to a project the reader has already left.
      url.searchParams.delete("project");
      url.searchParams.delete("source");
    }
    // `?artifact=` remains readable for old links, but identity is canonical in
    // the path just like production Documents, Issues, Sessions, Branches, and
    // Agents routes.
    url.searchParams.delete("artifact");
  } else {
    setParam(url.searchParams, "artifact", next.artifactId);
  }
  if (next.createOpen !== undefined) {
    setParam(url.searchParams, "create", next.createOpen ? "open" : null);
  }
  setParam(url.searchParams, "tab", next.tab);
  if (next.commentsOpen !== undefined) {
    setParam(url.searchParams, "comments", next.commentsOpen ? "open" : null);
  }
  setParam(url.searchParams, "comment", next.commentId);
  setParam(url.searchParams, "traceRow", next.traceRow);
  setParam(url.searchParams, "version", next.version);
  globalThis.window.history[mode === "push" ? "pushState" : "replaceState"](
    {},
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}

export function clearArtifactRouteState(
  mode: "push" | "replace" = "push",
  options: Pick<ArtifactRouteWriteOptions, "basePath"> = {}
) {
  writeArtifactRouteState(
    {
      artifactId: null,
      createOpen: false,
      commentId: null,
      commentsOpen: false,
      tab: null,
      traceRow: null,
      version: null,
    },
    mode,
    options
  );
}

export function buildArtifactRouteHref({
  artifactId,
  basePath,
  currentHref = globalThis.location?.href,
  routeKey,
  tab,
}: {
  artifactId: string;
  basePath: string;
  currentHref?: string;
  routeKey: string;
  tab: DetailTab;
}): string {
  const url = new URL(
    currentHref ?? normalizeBasePath(basePath),
    "http://prototype.local"
  );
  url.pathname = artifactDetailPath(basePath, routeKey || artifactId);
  url.searchParams.delete("artifact");
  url.searchParams.delete("create");
  // Collection-entry context, set only by the Projects screens when they hand
  // off to an artifact detail. A link built for the pre-hydration collection
  // must not carry it back, or the artifact reads as still scoped to the
  // project the user has already left.
  url.searchParams.delete("project");
  url.searchParams.delete("source");
  setParam(url.searchParams, "tab", tab);
  setParam(url.searchParams, "comments", null);
  setParam(url.searchParams, "comment", null);
  setParam(url.searchParams, "traceRow", null);
  setParam(url.searchParams, "version", null);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function artifactDetailPath(basePath: string, routeKey: string): string {
  return `${normalizeBasePath(basePath)}/${encodeURIComponent(routeKey)}`;
}

function readArtifactRouteKey(
  pathname: string,
  basePath: string | undefined
): string | null {
  if (!basePath) {
    return null;
  }
  const normalizedBase = normalizeBasePath(basePath);
  if (!pathname.startsWith(`${normalizedBase}/`)) {
    return null;
  }
  const remainder = pathname.slice(normalizedBase.length + 1);
  if (!remainder || remainder.includes("/")) {
    return null;
  }
  try {
    return decodeURIComponent(remainder);
  } catch {
    return remainder;
  }
}

function normalizeBasePath(basePath: string): string {
  const withoutTrailingSlash = basePath.replace(TRAILING_SLASHES_PATTERN, "");
  return withoutTrailingSlash || "/";
}

function setParam(
  params: URLSearchParams,
  key: string,
  value: string | number | null | undefined
) {
  if (value === undefined) {
    return;
  }
  if (value === null || value === "") {
    params.delete(key);
  } else {
    params.set(key, String(value));
  }
}

/**
 * Every `DetailTab` member, as a shape that cannot be written without naming
 * them all: a tab added to the union fails `tsc` here instead of silently
 * falling out of the parser and dropping the reader back on the first tab.
 */
const DETAIL_TAB_MEMBERS: Readonly<Record<DetailTab, true>> = {
  artifact: true,
  details: true,
  sessions: true,
  activity: true,
};

function isDetailTab(value: string | null): value is DetailTab {
  return value !== null && Object.hasOwn(DETAIL_TAB_MEMBERS, value);
}
