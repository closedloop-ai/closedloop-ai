import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
} from "@repo/api/src/types/artifact-activity-feed";
import { isHumanGitHubActor } from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { parseGitHubAuthorProviderDetailActorType } from "@/app/comments/github-author-provider-detail";

/** The columns {@link commentThreadActivityActor} reads off a thread row. */
export type CommentThreadActorRow = {
  createdById: string | null;
  source: string;
  /** The first live comment only: the author who opened the thread. */
  comments: readonly {
    authorId: string;
    githubProjection: {
      externalAuthor: { providerDetail: unknown } | null;
    } | null;
  }[];
};

/**
 * The actor of one projected comment thread (ISS-11004).
 *
 * A native thread keeps its recorded creator. A GitHub thread has none
 * (`createdById` is never set by the projection), so it is attributed to the
 * org user its root comment's GitHub author resolved to — a linked member or
 * that author's shadow user — and classified from the stored GitHub actor type
 * (operator ruling on PR #8562, 2026-10-08):
 * - `Bot` is `agent`, the feed's "automated caller" kind;
 * - `User`, `Mannequin` and `EnterpriseUserAccount` are `human`
 *   ({@link isHumanGitHubActor}).
 *
 * Without that evidence (no stored actor type, `Organization`, `unknown`) the
 * contract has no kind for "an external account of unknown type", so the row
 * keeps its earlier shape, `human` with no id, rather than naming an account it
 * cannot classify.
 */
export function commentThreadActivityActor(
  row: CommentThreadActorRow
): ActivityFeedActor {
  if (row.source !== ThreadSource.Github) {
    return { kind: ActivityFeedActorKind.Human, id: row.createdById };
  }
  const [root] = row.comments;
  const actorType = parseGitHubAuthorProviderDetailActorType(
    root?.githubProjection?.externalAuthor?.providerDetail
  );
  if (root && actorType === GitHubActorType.Bot) {
    return { kind: ActivityFeedActorKind.Agent, id: root.authorId };
  }
  if (root && isHumanGitHubActor(actorType)) {
    return { kind: ActivityFeedActorKind.Human, id: root.authorId };
  }
  return { kind: ActivityFeedActorKind.Human, id: row.createdById };
}
