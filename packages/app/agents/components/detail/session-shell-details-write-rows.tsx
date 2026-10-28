"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  ArtifactTagAvailability,
  TagEntityType,
} from "@repo/api/src/types/tag";
import { ArtifactProjectValue } from "@repo/app/projects/components/artifact-project-value";
import { ARTIFACT_PROJECT_FIELD_LABEL } from "@repo/app/projects/lib/project-field-labels";
import {
  type DetailsField,
  DetailsFieldId,
  DetailsRowFlag,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { ArtifactPriorityVariant } from "@repo/app/shared/lib/artifact-priority-ownership";
import { selfSavingField } from "@repo/app/shared/lib/details-field-constructors";
import { PRIORITY_COLUMN_LABEL } from "@repo/app/shared/lib/priority-constants";
import { EntityTagsCell } from "@repo/app/tags/components/entity-tags-cell";
import { sessionTitle } from "../../lib/session-title";
import { SessionPriorityValue } from "../sessions/session-priority-cell";

/**
 * ISS-10995: the Session Details tab's Priority, Project and Tags writes.
 *
 * All three are SELF-SAVING on the production controls the Sessions grid
 * mounts, so the org tag vocabulary, the permission split, the `/entity-tags`
 * attach/detach and the priority read-only/editable decision each have one
 * implementation. The renderer's own `onSave` path cannot serve them: each
 * write needs a provider-conditional hook call, and the tags editor it ships is
 * the design preview's, over a hardcoded vocabulary and tag NAMES where the
 * route takes an id.
 *
 * A session's wire `id` IS its Artifact id (`projections.ts` returns
 * `record.artifactId`), which is what every write keys on.
 */

/**
 * The editable set on Sessions is priority, project, tags and custom fields
 * (operator rulings 2026-10-09 and 2026-10-12).
 *
 * A source that carries none of them — Desktop single-user mode, whose detail
 * projection (`shared-agent-session-detail-projection.ts`) has no such
 * column — draws no row at all rather than a dash reading as "this session has
 * none" (operator ruling 2026-10-09).
 *
 * `undefined` is that absence; `null` is a session that genuinely has no
 * priority, which still draws, because that row is where one is set.
 */
export function priorityRow(
  session: AgentSessionDetail
): readonly DetailsField<DetailsFieldId>[] {
  const priority = session.priority;
  if (priority === undefined) {
    return [];
  }
  return [
    selfSavingField(DetailsFieldId.Priority, PRIORITY_COLUMN_LABEL, {
      kind: "self-saving",
      // Never empty: an unset priority is what the control exists to set, and
      // the empty-row rule would otherwise drop the row once a viewer is
      // locked out of editing it.
      empty: false,
      render: (editable) => (
        <SessionPriorityValue
          artifactId={session.id}
          priority={priority}
          readOnly={!editable}
          surface={ArtifactStatusEditSurface.Detail}
          variant={ArtifactPriorityVariant.DetailField}
        />
      ),
    }),
  ];
}

/**
 * Availability and the array are read TOGETHER, as the grid cell reads them: a
 * producer that never loaded the relation sends neither, and the picker's empty
 * state over that would claim a read nobody made.
 *
 * `maxVisible` is the whole array because `EntityTagsCell`'s default of 2 is a
 * GRID cap — one fixed-height line — while the row this replaced rendered
 * `TagList`, which wraps and shows every tag. Left at the default, a session
 * with five tags showed two and hid three behind a hover-only `+3`, on the tab
 * you open to read the set (#8697 review). This restores what the row showed;
 * a smaller cap for this surface is a product call nobody has made.
 */
export function tagsRow(
  session: AgentSessionDetail
): readonly DetailsField<DetailsFieldId>[] {
  const tags = session.tags;
  if (
    tags === undefined ||
    session.tagAvailability !== ArtifactTagAvailability.Available
  ) {
    return [];
  }
  return [
    {
      ...selfSavingField(DetailsFieldId.Tags, "Tags", {
        kind: "self-saving",
        empty: tags.length === 0,
        fill: true,
        render: (editable) => (
          <EntityTagsCell
            canApply={editable && (session.tagPermissions?.canApply ?? false)}
            canRemove={editable && (session.tagPermissions?.canRemove ?? false)}
            editLabel={`Edit tags for ${sessionTitle(session)}`}
            entityId={session.id}
            entityType={TagEntityType.Artifact}
            maxVisible={tags.length}
            surface={ArtifactStatusEditSurface.Detail}
            tags={tags}
          />
        ),
      }),
      flag: DetailsRowFlag.SessionsTags,
    },
  ];
}

/**
 * Project became editable with the 2026-10-12 operator ruling, and what a user
 * files here survives: ingest fills a session's project only while it has none
 * (`session-ingest-metadata-activity.ts`), so no later sync re-parents it.
 *
 * `undefined` is Desktop single-user mode, which has no project concept and
 * omits the field, and draws no row (ruling 2026-10-09). `null` is a session
 * filed into no project, which still draws — that row is where one is set.
 */
export function sessionProjectRow(
  session: AgentSessionDetail
): readonly DetailsField<DetailsFieldId>[] {
  const project = session.project;
  if (project === undefined) {
    return [];
  }
  return [
    selfSavingField(DetailsFieldId.Project, ARTIFACT_PROJECT_FIELD_LABEL, {
      kind: "self-saving",
      // Never empty: an unfiled session is what the control exists to file, and
      // the empty-row rule would otherwise drop the row once a viewer is locked
      // out of it — the same reason the Branch row reports `false`.
      empty: false,
      render: (editable) => (
        <ArtifactProjectValue
          artifactId={session.id}
          projectId={project?.id ?? null}
          projectName={project?.name ?? null}
          readOnly={!editable}
        />
      ),
    }),
  ];
}
