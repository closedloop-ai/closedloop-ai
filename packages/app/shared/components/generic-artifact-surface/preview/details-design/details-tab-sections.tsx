"use client";

import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { type ReactNode, useId, useState } from "react";
import { DetailsEditIndicatorContext } from "../components/artifact-detail-sections";
import { LinkedArtifactGroupsTable } from "../components/artifact-linked-artifacts-table";
import {
  type DetailsField,
  type DetailsFieldValue,
  type DetailsPriorityEditor,
  DetailsReadOnlyKind,
  type DetailsRowFlag,
} from "./details-design-model";
import {
  DetailsFieldCell,
  type DetailsRowProps,
  detailsReadOnlyWording,
  isDetailsFieldDrawn,
  useDetailsRowLabel,
} from "./details-sections";
import {
  type DetailsTabConfig,
  DetailsTabGroupId,
  groupDetailsTabFields,
} from "./details-tab-model";

export const DETAILS_TAB_CUSTOM_FIELDS_TITLE = "Custom fields";
export const DETAILS_TAB_ASSOCIATED_TITLE = "Associated artifacts";

/**
 * ISS-12252: the Details tab, on production's Session and Branch pages since
 * ISS-12412. The same rows and editors as `DetailsSections`, in the four
 * sections every type shares
 * (`groupDetailsTabFields`, ISS-12403): Artifact details, "<Type> details",
 * Custom fields, then Associated artifacts.
 *
 * - The host puts it on the Artifact tab's canvas card
 *   (`ArtifactCanvasPanel`, ISS-12403), at the width every tab on the page
 *   shares. Inside the card the sections are separated by a horizontal rule,
 *   with no border of their own (Nerys, 2026-10-12). Sections are always
 *   open.
 * - A row is a label and a value with no rules between rows. An editable value
 *   is the v2.0 editor with its hover pencil off: the hover background and
 *   the pointer cursor are the only cues (Kerensa, 2026-10-07). A read-only value
 *   has neither; its reason, when the host gives one, is a hover tooltip and
 *   the value's accessible description, with no lock.
 * - The empty-row rule is `DetailsSections`' (`isDetailsFieldDrawn`), and a group left
 *   with no rows is left out.
 * - Associated artifacts is production's grouped linked-artifacts table, one
 *   group per type with a Relationship column (ISS-12403); production's
 *   relationship words (Kerensa Whitlock 2026-10-09) on the live pages.
 */
export function DetailsTabSections({
  config,
  priorityEditor,
}: {
  config: DetailsTabConfig;
  priorityEditor: DetailsPriorityEditor;
}) {
  // As in v2.0: accepted values outlive the editor.
  const [accepted, setAccepted] = useState<
    Readonly<Record<string, DetailsFieldValue>>
  >({});
  const { base } = config;
  const rows = (fields: readonly DetailsField[]) =>
    fields.map((field) => (
      <DetailsTabRow
        errorLabel={base.saveErrorLabel}
        field={field}
        key={field.id}
        onAccepted={(next) =>
          setAccepted((current) => ({ ...current, [field.id]: next }))
        }
        priorityEditor={priorityEditor}
        readOnlyName={base.readOnlyName}
        value={accepted[field.id] ?? field.value}
      />
    ));
  const groups = groupDetailsTabFields(config)
    .map((group) => ({
      ...group,
      fields: group.fields.filter(isDetailsFieldDrawn),
    }))
    .filter((group) => group.fields.length > 0);
  const customFields = base.customFields.filter(isDetailsFieldDrawn);
  const associated = base.linked.filter((group) => group.rows.length > 0);
  const associatedCount = associated.reduce(
    (count, group) => count + group.rows.length,
    0
  );
  const viewerReason = viewerWideReason(config);

  return (
    <DetailsEditIndicatorContext.Provider value={false}>
      <div className="w-full" data-details-sections="">
        {viewerReason ? (
          <p
            className="mb-4 rounded-md bg-muted px-3 py-2 text-muted-foreground text-sm"
            role="note"
          >
            {viewerReason}
          </p>
        ) : null}
        {/* Its own box, so the first section drops its rule under the note. */}
        <div>
          {groups.map((group) => (
            <DetailsTabSection id={group.id} key={group.id} title={group.title}>
              {rows(group.fields)}
            </DetailsTabSection>
          ))}
          {customFields.length > 0 ? (
            <DetailsTabSection
              description={
                config.customFieldsProject
                  ? `From ${config.customFieldsProject}`
                  : undefined
              }
              id={DetailsTabGroupId.CustomFields}
              title={DETAILS_TAB_CUSTOM_FIELDS_TITLE}
            >
              {rows(customFields)}
            </DetailsTabSection>
          ) : null}
          {base.linkedUnavailable || associatedCount > 0 ? (
            <DetailsTabSection
              count={base.linkedUnavailable ? undefined : associatedCount}
              id={DetailsTabGroupId.Associated}
              title={DETAILS_TAB_ASSOCIATED_TITLE}
            >
              {base.linkedUnavailable ? (
                <p className="py-1.5 text-muted-foreground text-sm">
                  {base.linkedUnavailable}
                </p>
              ) : (
                <div className="pt-1">
                  <LinkedArtifactGroupsTable groups={associated} />
                </div>
              )}
            </DetailsTabSection>
          ) : null}
        </div>
      </div>
    </DetailsEditIndicatorContext.Provider>
  );
}

/**
 * Why the viewer can change nothing right now (offline, no permission), said
 * once at the top where every viewer sees it, keyboard and touch included. A
 * row's own tooltip is hover-only; this is the reason that matters most.
 */
function viewerWideReason(config: DetailsTabConfig): string | null {
  for (const field of [...config.base.core, ...config.base.customFields]) {
    const reason = detailsReadOnlyWording(field);
    if (reason && reason.kind !== DetailsReadOnlyKind.NotEditable) {
      return reason.text;
    }
  }
  return null;
}

/**
 * A titled group of rows, below a horizontal rule; the first has none
 * (ISS-12403). Groups are always open (Nerys, 2026-10-08).
 */
export function DetailsTabSection({
  children,
  count,
  description,
  id,
  title,
}: {
  children: ReactNode;
  count?: number;
  description?: string;
  id: string;
  title: string;
}) {
  // A div, not a section: a tab of named regions is landmark noise.
  return (
    <div
      className="border-t pt-4 pb-4 first:border-t-0 first:pt-0 last:pb-0"
      data-details-group={id}
    >
      <div className="flex items-baseline gap-2 py-1">
        <h2 className="font-semibold text-sm">{title}</h2>
        {count === undefined ? null : (
          <span className="text-muted-foreground text-xs tabular-nums">
            {count}
            <span className="sr-only"> linked</span>
          </span>
        )}
        {description ? (
          <span className="truncate text-muted-foreground text-xs">
            {description}
          </span>
        ) : null}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function DetailsTabRow(props: DetailsRowProps) {
  return props.field.flag ? (
    <FlaggedTabRow flag={props.field.flag} {...props} />
  ) : (
    <UngatedTabRow {...props} />
  );
}

/** Production's own flag, read at the row, as v2.0 does. */
function FlaggedTabRow({
  flag,
  ...props
}: DetailsRowProps & { flag: DetailsRowFlag }) {
  return useFeatureFlagEnabledOptional(flag) === true ? (
    <UngatedTabRow {...props} />
  ) : null;
}

function UngatedTabRow(props: DetailsRowProps) {
  const { field } = props;
  const label = useDetailsRowLabel(field);
  const labelId = useId();
  const reasonId = useId();
  const reason = detailsReadOnlyWording(field);
  const cell = <DetailsFieldCell {...props} />;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a label/value row is not a form fieldset; the group only names the value by its label.
    <div
      aria-describedby={reason ? reasonId : undefined}
      aria-labelledby={labelId}
      className="grid min-h-9 grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-x-3 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]"
      data-details-field={field.id}
      role="group"
    >
      <div
        className="truncate py-1.5 text-muted-foreground"
        id={labelId}
        title={label}
      >
        {label}
      </div>
      <div className="flex min-w-0 items-center">
        {reason ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="min-w-0">{cell}</div>
              </TooltipTrigger>
              <TooltipContent align="start" side="bottom">
                {reason.text}
              </TooltipContent>
            </Tooltip>
            <span className="sr-only" id={reasonId}>
              {reason.text}
            </span>
          </>
        ) : (
          cell
        )}
      </div>
    </div>
  );
}
