"use client";

import type { ArtifactActivityFeedItem } from "@repo/api/src/types/artifact-activity-feed";
import { ActivityFeedActorKind } from "@repo/api/src/types/artifact-activity-feed";
import type { DocumentType } from "@repo/api/src/types/document";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { ActivityCommentEntry } from "@repo/app/documents/components/artifact-activity/activity-comment-entry";
import { ActivityEntry } from "@repo/app/documents/components/artifact-activity/activity-entry";
import { ActivityParts } from "@repo/app/documents/components/artifact-activity/activity-parts";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  ActivityActor,
  ActivityActorAvatar,
  ActivityActorName,
  ActivityApiBadge,
} from "./activity-actor";
import { ActivityCardView } from "./activity-card-view";
import {
  useOrgUserDirectory,
  useProjectDirectory,
  useTagDirectory,
} from "./activity-directory";
import {
  type ActivityLinkLookups,
  type ActivityLookups,
  describeActivityParts,
  resolveActivityActor,
} from "./activity-formatting";
import { activityChangedFieldKey } from "./activity-snapshot";
import { useActivitySourceContext } from "./activity-source-provider";
import {
  type ActivityFeedItem,
  ActivityArtifactKind as ArtifactKinds,
} from "./activity-types";

/**
 * Whose feed a row belongs to. Declared in `activity-types.ts` so the pure
 * adapter can read it; bound here too so existing importers keep their path.
 */
export const ActivityArtifactKind = ArtifactKinds;
export type ActivityArtifactKind =
  (typeof ActivityArtifactKind)[keyof typeof ActivityArtifactKind];

/**
 * The two looks one activity row has (Nerys, 2026-10-07). Both read the same
 * adapter (`describeActivityParts`), so they can never word a row differently:
 * - `rail`: the Document comments rail's compact bordered card
 *   (`ActivityCardView`), actor and time on top, the phrase below.
 * - `timeline`: the Activity tab's GitHub-inspired line, read who, what, when,
 *   with the actor's avatar on the timeline's line (`ActivityEntry`): a
 *   person's photo or initials, the cog for System, the robot for an agent.
 */
export const ActivityCardLayout = {
  Rail: "rail",
  Timeline: "timeline",
} as const;
export type ActivityCardLayout =
  (typeof ActivityCardLayout)[keyof typeof ActivityCardLayout];

/**
 * Container for one activity row: resolves the ids on the row (people,
 * projects, tags) against the org directories, words it through the adapter,
 * and hands the result to the chosen look.
 *
 * A pure formatter cannot turn a uuid into a person, a project or a tag — only
 * a directory can, and rendering the id instead is the ISS-5007 defect. The
 * directory state reaches the adapter whole (pending / ready / unavailable),
 * so a lookup in flight shows a placeholder and a failed one names nobody.
 */
export function ActivityCard({
  item,
  documentType,
  artifactKind = ActivityArtifactKind.Document,
  layout = ActivityCardLayout.Rail,
  links,
  now,
}: Readonly<{
  item: ActivityFeedItem;
  documentType?: DocumentType;
  artifactKind?: ActivityArtifactKind;
  layout?: ActivityCardLayout;
  /** Host-supplied links (versions, runs, reports, related artifacts). */
  links?: ActivityLinkLookups;
  /** The clock relative times are measured against. */
  now?: Date | number;
}>) {
  const { event } = item;
  const lookups = {
    ...useActivityLookups(event, { artifactKind, documentType }),
    ...links,
  };
  const description = describeActivityParts(event, lookups);

  if (layout === ActivityCardLayout.Timeline) {
    return (
      <ActivityEntry
        actor={<ActivityActorName actor={description.actor} />}
        avatar={<ActivityActorAvatar actor={description.actor} kindGlyph />}
        badge={description.badge ? <ActivityApiBadge /> : undefined}
        createdAt={event.createdAt}
        now={now}
        suffix={description.suffix}
      >
        <ActivityParts parts={description.parts} />
      </ActivityEntry>
    );
  }

  return (
    <ActivityCardView
      actor={
        <ActivityActor
          actor={event.actor}
          directory={lookups.users ?? UNAVAILABLE_USERS}
        />
      }
      createdAt={event.createdAt}
      headline={
        <>
          <ActivityParts parts={description.parts} />
          {description.suffix ? (
            <>
              {" "}
              <span className="whitespace-nowrap text-muted-foreground">
                · {description.suffix}
              </span>
            </>
          ) : null}
        </>
      }
      now={now}
    />
  );
}

const UNAVAILABLE_USERS = {
  status: "unavailable",
  find: () => null,
} as const satisfies NonNullable<ActivityLookups["users"]>;

/**
 * The directories and flags a row's wording depends on. Projects and tags are
 * only read when the row names one, so a feed without such rows never fetches
 * them; React Query dedupes the read across the rows that do.
 */
function useActivityLookups(
  event: ArtifactActivityFeedItem,
  context: {
    artifactKind: ActivityArtifactKind;
    documentType: DocumentType | undefined;
  }
): ActivityLookups {
  const field = activityChangedFieldKey(event);
  const users = useOrgUserDirectory();
  const projects = useProjectDirectory(field === "projectId");
  const tags = useTagDirectory(field === "tag");
  const universalStatus = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  return {
    users,
    projects,
    tags,
    universalStatus,
    artifactKind: context.artifactKind,
    documentType: context.documentType,
  };
}

/**
 * A comment as an activity row (ISS-10843): who commented and when, plus a
 * read-only link to the comment. There is no reply, reaction or edit here; the
 * comment itself lives in the comments rail. Comments are not stored as
 * activity events, so the host builds these rows from its comment source.
 */
export function ActivityCommentCard({
  authorId,
  createdAt,
  href,
  body,
  unavailable = false,
  layout = ActivityCardLayout.Rail,
  now,
}: Readonly<{
  authorId: string;
  createdAt: Date;
  href: string;
  /** The comment's text, when the host has it (timeline look only). */
  body?: string | null;
  /** The comment was deleted or can no longer be read (timeline look only). */
  unavailable?: boolean;
  layout?: ActivityCardLayout;
  /** The clock relative times are measured against. */
  now?: Date | number;
}>) {
  const users = useOrgUserDirectory();
  const actor = { kind: ActivityFeedActorKind.Human, id: authorId };

  if (layout === ActivityCardLayout.Timeline) {
    const resolved = resolveActivityActor(actor, users);
    return (
      <ActivityCommentEntry
        actor={<ActivityActorName actor={resolved} />}
        avatar={<ActivityActorAvatar actor={resolved} kindGlyph />}
        body={body}
        createdAt={createdAt}
        href={href}
        now={now}
        unavailable={unavailable}
      />
    );
  }

  return (
    <ActivityCardView
      actor={<ActivityActor actor={actor} directory={users} />}
      createdAt={createdAt}
      headline="commented"
      link={{ href, label: "View comment" }}
      now={now}
    />
  );
}

/** Production wrapper that reads the artifact subtype from the source owner. */
export function ActivitySourceCard({
  item,
}: Readonly<{ item: ActivityFeedItem }>) {
  const { documentType } = useActivitySourceContext();
  return <ActivityCard documentType={documentType} item={item} />;
}
