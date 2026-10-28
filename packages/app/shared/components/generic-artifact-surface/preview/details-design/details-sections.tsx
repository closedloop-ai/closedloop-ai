"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { artifactStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";
import { CalendarIcon, LockIcon, PencilIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
  ArtifactDetailSection,
  DetailTable,
  DetailTableRow,
  DetailTagsEditor,
  InlineFieldTextEditor,
  OwnerEditor,
  useDetailsEditIndicator,
} from "../components/artifact-detail-sections";
import { LinkedArtifactGroupsTable } from "../components/artifact-linked-artifacts-table";
import {
  DETAILS_SECTION_TITLES,
  type DetailsConfig,
  type DetailsField,
  type DetailsFieldValue,
  type DetailsPriorityEditor,
  DetailsReadOnlyKind,
  type DetailsReadOnlyReason,
  DetailsRowFlag,
  type DetailsRowValue,
  DetailsSectionId,
  isDetailsValueEmpty,
} from "./details-design-model";
import { DETAILS_EMPTY_VALUE, FieldValue } from "./details-field-value";

/**
 * ISS-10792 -- the one renderer every artifact type's Details tab would
 * share, drawn as the web-master generic-artifact prototype's Details tab:
 * one bordered label / value table, then "Custom fields" and "Linked
 * artifacts" under the prototype's section headings. Editable values are the
 * prototype's controls (popover text editor with a hover pencil, Enter /
 * Escape, the owner menu, the tags picker) and the design-system date
 * picker; status and priority are the canonical components. A read-only row
 * shows a lock where the pencil would be, on hover or focus, and it opens the
 * host's reason on click or tap; the reason is also in the lock's accessible
 * name. A host's custom cell draws its own value. A row with a `flag` reads
 * it here, at the leaf. A read-only row whose value is empty is not drawn
 * (ISS-12197; `isDetailsValueEmpty`), an editable one always is, and a block
 * left with no rows is left out. Revision history is never drawn here
 * (ISS-10792 AC).
 */
export function DetailsSections({
  config,
  priorityEditor,
}: {
  config: DetailsConfig;
  priorityEditor: DetailsPriorityEditor;
}) {
  // Accepted values outlive the editor, so switching the viewer situation
  // and back does not repaint the fixture over a saved edit.
  const [accepted, setAccepted] = useState<
    Readonly<Record<string, DetailsFieldValue>>
  >({});
  const rows = (fields: readonly DetailsField[]) =>
    fields.map((field) => (
      <DetailsRow
        errorLabel={config.saveErrorLabel}
        field={field}
        key={field.id}
        onAccepted={(next) =>
          setAccepted((current) => ({ ...current, [field.id]: next }))
        }
        priorityEditor={priorityEditor}
        readOnlyName={config.readOnlyName}
        value={accepted[field.id] ?? field.value}
      />
    ));
  const core = config.core.filter(isDetailsFieldDrawn);
  const customFields = config.customFields.filter(isDetailsFieldDrawn);
  const linkRows = config.linkRows.filter(isDetailsFieldDrawn);
  const linked = config.linked.filter((group) => group.rows.length > 0);
  const hasLinks =
    linkRows.length > 0 ||
    linked.length > 0 ||
    Boolean(config.linkedUnavailable);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-5 pb-10">
      <div data-details-section={DetailsSectionId.Core}>
        <DetailTable>{rows(core)}</DetailTable>
      </div>
      {customFields.length > 0 ? (
        <div data-details-section={DetailsSectionId.CustomFields}>
          <ArtifactDetailSection
            title={DETAILS_SECTION_TITLES[DetailsSectionId.CustomFields]}
          >
            <DetailTable>{rows(customFields)}</DetailTable>
          </ArtifactDetailSection>
        </div>
      ) : null}
      {hasLinks ? (
        <div data-details-section={DetailsSectionId.Links}>
          <ArtifactDetailSection
            title={DETAILS_SECTION_TITLES[DetailsSectionId.Links]}
          >
            {linkRows.length > 0 ? (
              <DetailTable>{rows(linkRows)}</DetailTable>
            ) : null}
            {config.linkedUnavailable ? (
              <p className="px-4 py-3 text-muted-foreground text-sm">
                {config.linkedUnavailable}
              </p>
            ) : null}
            {!config.linkedUnavailable && linked.length > 0 ? (
              <LinkedArtifactGroupsTable groups={linked} />
            ) : null}
          </ArtifactDetailSection>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ISS-12197's empty-row rule ("has a value or is editable"), at the one place
 * rows are chosen. Only the host knows which fields production writes, and it
 * says so by marking the ones it never writes `NotEditable`: those are left
 * out when empty. Every other read-only row is a field production writes that
 * this tab does not (ISS-10796 ships Details read-only) or the viewer cannot
 * right now (offline, no permission), so it stays drawn like the editable row
 * it is — a session's Priority, Owner and Owning project are PATCH fields and
 * must not vanish for being unset (PR #8555 review).
 *
 * A self-saving row (a custom field) follows its own rule (ISS-12302, Kerensa
 * 2026-10-08): drawn while the viewer can edit it, and once locked, drawn only
 * when it has a value, whatever the lock's reason.
 */
export function isDetailsFieldDrawn(field: DetailsField): boolean {
  if (field.edit.mode !== "read-only") {
    return true;
  }
  if (field.value.kind === "self-saving") {
    return !field.value.empty;
  }
  if (field.edit.reason?.kind !== DetailsReadOnlyKind.NotEditable) {
    return true;
  }
  return !isDetailsValueEmpty(field.value);
}

export type DetailsRowProps = {
  errorLabel: string;
  field: DetailsField;
  readOnlyName: DetailsConfig["readOnlyName"];
  onAccepted: (next: DetailsFieldValue) => void;
  priorityEditor: DetailsPriorityEditor;
  value: DetailsRowValue;
};

function DetailsRow(props: DetailsRowProps) {
  return props.field.flag ? (
    <FlaggedRow flag={props.field.flag} {...props} />
  ) : (
    <UngatedRow {...props} />
  );
}

/** Production's own flag, read at the row; off renders nothing, as production does. */
function FlaggedRow({
  flag,
  ...props
}: DetailsRowProps & { flag: DetailsRowFlag }) {
  return useFeatureFlagEnabledOptional(flag) === true ? (
    <UngatedRow {...props} />
  ) : null;
}

/**
 * Production's other label for the row, read at the row while its flag is on.
 * A host cell that names itself after its row (`PartialValueCell`) reads it
 * here too, so the two never resolve the flag differently.
 */
export function useDetailsRowLabel(
  field: Pick<DetailsField, "flaggedLabel" | "label">
) {
  // The flag scanner (scripts/lint/posthog-flag-module-index.ts) reads a
  // literal or a constant-object member, so the key is named here, not
  // computed: ONE_LABEL_PER_METRIC is the only flag that swaps a row's label.
  const flagged = useFeatureFlagEnabledOptional(
    DetailsRowFlag.OneLabelPerMetric
  );
  return field.flaggedLabel && flagged === true
    ? field.flaggedLabel.label
    : field.label;
}

function UngatedRow(props: DetailsRowProps) {
  const { field, readOnlyName } = props;
  const label = useDetailsRowLabel(field);
  const reasonId = useId();
  const reason = detailsReadOnlyWording(field);
  return (
    <DetailTableRow
      label={label}
      value={
        <div
          aria-describedby={reason ? reasonId : undefined}
          className="group/value flex min-w-0 items-center gap-1"
          data-details-field={field.id}
        >
          <DetailsFieldCell {...props} />
          {reason ? (
            <>
              <span className="sr-only" id={reasonId}>
                {reason.text}
              </span>
              <ReadOnlyLock
                name={readOnlyName(label, reason.text)}
                reason={reason}
              />
            </>
          ) : null}
        </div>
      }
    />
  );
}

export function DetailsFieldCell(props: DetailsRowProps) {
  const { field, value } = props;
  if (value.kind !== "self-saving") {
    return <SavingFieldCell {...props} value={value} />;
  }
  return field.edit.mode === "self-saving" ? (
    <span className={cn("min-w-0", value.fill && "flex-1")}>
      {value.render(true)}
    </span>
  ) : (
    <FieldValue value={value} />
  );
}

function SavingFieldCell({
  errorLabel,
  field,
  onAccepted,
  priorityEditor,
  value,
}: DetailsRowProps & { value: DetailsFieldValue }) {
  const [failed, setFailed] = useState(false);
  // Optimistic writes, newest last. Only the newest write's refusal rolls
  // back, and it rolls back to the last value a write CONFIRMED, never to a
  // choice that was itself refused.
  const writes = useRef({ confirmed: 0, latest: 0, pending: 0 });
  const confirmedValue = useRef(value);
  const indicator = useDetailsEditIndicator();
  if (field.edit.mode !== "editable") {
    return <FieldValue value={value} />;
  }
  const { onSave } = field.edit;
  /** Waits for the write; a rejection leaves the accepted value in place. */
  const save = async (next: DetailsFieldValue) => {
    setFailed(false);
    await onSave(next);
    onAccepted(next);
  };
  /** Priority and status editors close on select; a refusal still shows. */
  const saveOrSay = (next: DetailsFieldValue) =>
    save(next).catch((error: unknown) => {
      setFailed(true);
      throw error;
    });
  /** Menus close on select, so they show the choice and undo a refused write. */
  const saveOptimistically = (next: DetailsFieldValue) => {
    const track = writes.current;
    if (track.pending === 0) {
      confirmedValue.current = value;
    }
    track.latest += 1;
    track.pending += 1;
    const write = track.latest;
    setFailed(false);
    onAccepted(next);
    onSave(next).then(
      () => {
        track.pending -= 1;
        if (write > track.confirmed) {
          track.confirmed = write;
          confirmedValue.current = next;
        }
      },
      () => {
        track.pending -= 1;
        if (write === track.latest) {
          onAccepted(confirmedValue.current);
          setFailed(true);
        }
      }
    );
  };
  const failure = failed ? (
    <span className="text-destructive text-xs" role="alert">
      {errorLabel}
    </span>
  ) : null;

  switch (value.kind) {
    case "priority":
      return (
        <>
          <EditablePriority
            Editor={priorityEditor}
            onSave={saveOrSay}
            value={value}
          />
          {failure}
        </>
      );
    case "status":
      return value.allowedTargets ? (
        <>
          <EditableStatus
            label={field.label}
            onSave={saveOrSay}
            value={value}
          />
          {failure}
        </>
      ) : (
        <FieldValue value={value} />
      );
    case "text":
      return (
        <InlineFieldTextEditor
          emptyLabel={DETAILS_EMPTY_VALUE}
          errorLabel={errorLabel}
          label={field.label}
          monospace={value.mono}
          onChange={(next) => save({ ...value, text: next })}
          value={value.text}
        />
      );
    case "person":
      return (
        <>
          <OwnerEditor
            label={field.label.toLowerCase()}
            onChange={(name) => saveOptimistically({ ...value, name })}
            people={value.choices}
            value={value.name}
          />
          {failure}
        </>
      );
    case "tags":
      return (
        <>
          <DetailTagsEditor
            emptyLabel={
              <span className="text-muted-foreground">
                {DETAILS_EMPTY_VALUE}
              </span>
            }
            onChange={(tags) => saveOptimistically({ ...value, tags })}
            tags={value.tags}
          />
          {failure}
        </>
      );
    case "date":
      return (
        <>
          <DatePickerPopover
            onSelect={(date) =>
              saveOptimistically({
                ...value,
                date: date ? isoDay(date) : null,
              })
            }
            trigger={
              <button
                aria-label={`Edit ${field.label.toLowerCase()}`}
                className="group flex items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-muted/60"
                type="button"
              >
                <CalendarIcon className="size-4 text-muted-foreground" />
                <span className={cn(!value.date && "text-muted-foreground")}>
                  {value.date ?? DETAILS_EMPTY_VALUE}
                </span>
                {indicator.pencil ? (
                  <PencilIcon className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                ) : null}
              </button>
            }
            value={value.date ? new Date(`${value.date}T00:00:00`) : null}
          />
          {failure}
        </>
      );
    default:
      // A kind with no canonical editor stays read-only rather than falling
      // back to free text.
      return <FieldValue value={value} />;
  }
}

/** The picked calendar day, in local time, as `yyyy-mm-dd`. */
function isoDay(date: Date) {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

type PriorityValue = Extract<DetailsFieldValue, { kind: "priority" }>;
type StatusValue = Extract<DetailsFieldValue, { kind: "status" }>;

function EditablePriority({
  Editor,
  onSave,
  value,
}: {
  Editor: DetailsPriorityEditor;
  onSave: (next: DetailsFieldValue) => Promise<void>;
  value: PriorityValue;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Editor
      mutationActivity={saving}
      onSelect={async (next) => {
        setSaving(true);
        try {
          await onSave({ ...value, priority: next });
        } catch {
          // A refused save leaves the accepted value in place.
        } finally {
          setSaving(false);
        }
      }}
      priority={value.priority}
      support={value.support}
    />
  );
}

function EditableStatus({
  label,
  onSave,
  value,
}: {
  label: string;
  onSave: (next: DetailsFieldValue) => Promise<void>;
  value: StatusValue;
}) {
  return (
    <ArtifactStatus
      ariaLabel={label}
      capability={{
        allowedTargets: value.allowedTargets ?? [],
        editable: true,
      }}
      onCommit={(commit) => {
        onSave({
          ...value,
          view: artifactStatusView(
            value.view.artifactId,
            value.view.vocabulary,
            commit.to
          ),
        }).catch(() => {
          // A refused save leaves the accepted value in place.
        });
      }}
      surface={ArtifactStatusEditSurface.Detail}
      variant={ArtifactStatusVariant.Editor}
      view={value.view}
    />
  );
}

/**
 * The lock in the pencil's place. A situation lock (offline, no permission)
 * is a tab stop, because the field would otherwise be editable. A
 * never-editable field's lock stays clickable and tappable but out of the tab
 * order; its reason is the row's accessible description instead.
 */
export type DetailsReadOnlyWording = Extract<
  DetailsReadOnlyReason,
  { text: string }
>;

/** A lock is drawn only where the host supplied wording for it. */
export function detailsReadOnlyWording(
  field: DetailsField
): DetailsReadOnlyWording | null {
  if (field.edit.mode !== "read-only" || field.edit.reason === undefined) {
    return null;
  }
  const { reason } = field.edit;
  return reason.text === undefined ? null : { ...reason, text: reason.text };
}

function ReadOnlyLock({
  name,
  reason,
}: {
  name: string;
  reason: DetailsReadOnlyWording;
}) {
  const situational = reason.kind !== DetailsReadOnlyKind.NotEditable;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={name}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/value:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-60"
          tabIndex={situational ? undefined : -1}
          type="button"
        >
          <LockIcon aria-hidden="true" className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-xs p-2 text-xs">
        {reason.text}
      </PopoverContent>
    </Popover>
  );
}
