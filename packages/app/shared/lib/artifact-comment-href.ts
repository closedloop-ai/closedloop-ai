/**
 * ISS-11004 / ISS-10980: deep-link addressing for one of an artifact's
 * comments, so an Activity tab's comment rows can point at the comment they
 * report. A comment is addressed by `(detail route, threadId)`; the route is
 * the artifact's detail path and `threadId` is a `?comment=` query param
 * naming the thread the comments rail should open on.
 *
 * The address is the THREAD, not a comment row: the feed projects one item per
 * top-level thread (operator, 2026-10-07), and `Comment.id` and
 * `Comment.threadId` are separate columns, so addressing a comment id would
 * name something the rail's thread cards never carry.
 *
 * SSOT for the param name on both the writing (href builder) and reading
 * (param parser) sides, the same split `session-transcript-href.ts` keeps for
 * `?file=` and `?invocationAnchor=`. ONE module rather than one per artifact:
 * the param name is a single contract, and a second copy of it is how the
 * writing and reading halves drift apart.
 */

import type { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import {
  ARTIFACT_COMMENT_PARAM,
  DEFAULT_TAB_PARAM,
} from "@repo/app/shared/lib/detail-route-params";
import type { ReadonlySearchParams } from "@repo/navigation/navigation-adapter";

/**
 * A thread id long enough to be a plausible identifier and short enough not to
 * be a pasted payload. A value outside the bound is dropped rather than
 * forwarded, so a hostile or truncated URL cannot drive the rail.
 */
const MAX_THREAD_ID_CHARS = 512;

/** The addressed thread id, or null when the URL names none that could be one. */
export function readArtifactCommentThreadId(
  searchParams: ReadonlySearchParams
): string | null {
  const raw = searchParams.get(ARTIFACT_COMMENT_PARAM);
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_THREAD_ID_CHARS) {
    return null;
  }
  return trimmed;
}

/**
 * A link to `threadId` on the detail route at `path`. Existing params are
 * preserved, so a link built from the current URL keeps the reader's other
 * addressing.
 *
 * `railTab` names the tab the rail is beside, which every surface must supply:
 * an address that lands the reader on a tab with no rail cannot open the
 * thread it names. Session's rail is mounted inside its Sessions panel;
 * Branch's is page-level but the approved design (ISS-10963) shows it beside
 * Artifact and Sessions only, never Activity.
 */
export function withArtifactCommentParam({
  path,
  searchParams,
  threadId,
  railTab,
}: Readonly<{
  path: string;
  searchParams: ReadonlySearchParams;
  threadId: string;
  railTab: ArtifactDetailTab;
}>): string {
  const params = new URLSearchParams(searchParams.toString());
  params.set(DEFAULT_TAB_PARAM, railTab);
  params.set(ARTIFACT_COMMENT_PARAM, threadId);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
