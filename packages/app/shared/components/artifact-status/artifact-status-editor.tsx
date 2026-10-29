"use client";

import type {
  ArtifactStatusRoot,
  NormalizedArtifactStatus,
} from "@repo/api/src/types/artifact-status";
import type {
  ArtifactStatusCommitFor,
  ArtifactStatusRawValue,
  ArtifactStatusReadOnlyReason,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import {
  ArtifactStatusEditSurface,
  ArtifactStatusReadOnlyReason as ReadOnlyReason,
} from "@repo/api/src/types/artifact-status-contract";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import { resolveArtifactStatusMark } from "@repo/app/shared/lib/artifact-status-appearance";
import { groupArtifactStatusTargets } from "@repo/app/shared/lib/artifact-status-targets";
import type {
  ArtifactStatusEditorProps,
  ArtifactStatusSingleSubjectEditSurface,
  ArtifactStatusView,
} from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { automaticReason } from "@repo/app/shared/lib/details-lock-copy";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { StatusAppearanceIcon } from "@repo/design-system/components/ui/status-icon-primitives";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useRef } from "react";
import {
  ArtifactStatusDisplayMark,
  ArtifactStatusMark,
} from "./artifact-status-marks";
import {
  artifactStatusFullLabel,
  artifactStatusLabel,
  useArtifactStatusPresentation,
} from "./artifact-status-presentation";

/**
 * The one variant that WRITES.
 *
 * Editability is read from `capability` and never from whether `onCommit` was
 * passed (UAS-024). A read-only row therefore renders the mark plus the REASON
 * and no interactive control at all, which is the state the handler-presence
 * inference could not express: "editable but refused" and "read-only because
 * provider-derived" were the same absent handler.
 */
export function ArtifactStatusEditor<
  S extends ArtifactStatusSingleSubjectEditSurface,
>(props: ArtifactStatusEditorProps<S>) {
  const {
    ariaLabel,
    capability,
    onCancel,
    onCommit,
    surface,
    triggerId,
    triggerVariant,
    view,
  } = props;

  if (capability.editable) {
    return (
      <EditableArtifactStatus
        allowedTargets={capability.allowedTargets}
        ariaLabel={ariaLabel}
        onCancel={onCancel}
        onCommit={onCommit}
        surface={surface}
        triggerId={triggerId}
        triggerVariant={triggerVariant}
        view={view}
      />
    );
  }

  return (
    <ReadOnlyArtifactStatus
      ariaLabel={ariaLabel}
      reason={capability.reason}
      surface={surface}
      triggerId={triggerId}
      triggerVariant={triggerVariant}
      view={view}
    />
  );
}

/**
 * What each refusal says, in the reader's terms. Exhaustive `Record`, so a fifth
 * reason fails `tsc` here rather than reaching {@link READ_ONLY_FALLBACK_COPY}.
 *
 */
const ARTIFACT_STATUS_READ_ONLY_COPY: Readonly<
  Record<
    Exclude<
      ArtifactStatusReadOnlyReason,
      typeof ReadOnlyReason.UnrecognizedStatus
    >,
    string
  >
> = Object.freeze({
  [ReadOnlyReason.ProviderDerived]:
    "Set outside Closedloop, so it cannot be changed here.",
  [ReadOnlyReason.MachineWritten]: automaticReason,
  [ReadOnlyReason.NotPermitted]:
    "You do not have permission to change this status.",
});

/** For a reason a version-skewed producer invented: refuse, and say only that. */
const READ_ONLY_FALLBACK_COPY = "This status cannot be changed here.";

/**
 * An empty `allowedTargets` is honest and is NOT a refusal: the control exists
 * and opens, and states that nothing is a legal move right now.
 */
const NO_ALLOWED_TARGETS_COPY = "No status change is available right now.";

function ReadOnlyArtifactStatus({
  ariaLabel,
  reason,
  surface,
  triggerId,
  triggerVariant,
  view,
}: Readonly<{
  ariaLabel?: string;
  reason: ArtifactStatusReadOnlyReason;
  surface: ArtifactStatusSingleSubjectEditSurface;
  triggerId?: string;
  triggerVariant?: typeof ArtifactStatusVariant.Icon;
  view: ArtifactStatusView;
}>) {
  const presentation = useArtifactStatusPresentation(view);

  if (triggerVariant === ArtifactStatusVariant.Icon) {
    const refusalCopy = artifactStatusReadOnlyReasonCopy(reason);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={
              ariaLabel ?? `${presentation.accessibleName}. ${refusalCopy}`
            }
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${CHIP_FOCUS_RING_CLASS}`}
            id={triggerId}
            type="button"
          >
            <span aria-hidden>
              <ArtifactStatusMark
                variant={ArtifactStatusVariant.Icon}
                view={view}
              />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent>{refusalCopy}</TooltipContent>
      </Tooltip>
    );
  }

  if (reason === ReadOnlyReason.UnrecognizedStatus) {
    const mark = (
      <ArtifactStatusDisplayMark
        presentation={{ ...presentation, description: undefined }}
      />
    );
    if (!presentation.description) {
      return (
        <output
          aria-label={ariaLabel}
          className="inline-flex items-center"
          id={triggerId}
        >
          {mark}
        </output>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={ariaLabel ?? presentation.accessibleName}
            className="inline-flex items-center rounded-md px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id={triggerId}
            type="button"
          >
            {mark}
          </button>
        </TooltipTrigger>
        <TooltipContent>{presentation.description}</TooltipContent>
      </Tooltip>
    );
  }

  const refusalCopy = artifactStatusReadOnlyReasonCopy(reason);
  if (surface === ArtifactStatusEditSurface.InlineCell) {
    return (
      <fieldset
        aria-label={
          ariaLabel ?? `${artifactStatusFullLabel(view)}. ${refusalCopy}`
        }
        className="m-0 inline-flex min-w-0 flex-col items-start justify-center gap-y-0.5 border-0 p-0 max-md:max-w-full"
        id={triggerId}
        title={refusalCopy}
      >
        <ArtifactStatusMark
          variant={ArtifactStatusVariant.CompactCell}
          view={view}
        />
        <span className="whitespace-nowrap text-muted-foreground text-xs leading-tight max-md:whitespace-normal">
          {refusalCopy}
        </span>
      </fieldset>
    );
  }

  return (
    <fieldset
      aria-label={ariaLabel}
      className="m-0 inline-flex min-w-0 items-center gap-2 border-0 p-0 max-md:w-full max-md:flex-col max-md:items-start max-md:gap-y-0.5"
      id={triggerId}
    >
      <ArtifactStatusMark variant={ArtifactStatusVariant.Display} view={view} />
      <span className="text-muted-foreground text-xs">{refusalCopy}</span>
    </fieldset>
  );
}

function EditableArtifactStatus<
  S extends ArtifactStatusSingleSubjectEditSurface,
>({
  allowedTargets,
  ariaLabel,
  onCancel,
  onCommit,
  surface,
  triggerId,
  triggerVariant,
  view,
}: Readonly<{
  allowedTargets: readonly ArtifactStatusRawValue[];
  ariaLabel?: string;
  onCancel?: () => void;
  onCommit: (commit: ArtifactStatusCommitFor<S>) => void;
  surface: S;
  triggerId?: string;
  triggerVariant?: typeof ArtifactStatusVariant.Icon;
  view: ArtifactStatusView;
}>) {
  const { accessibleName } = useArtifactStatusPresentation(view);
  const targetGroups = groupArtifactStatusTargets(
    allowedTargets,
    view.vocabulary
  );
  // Whether THIS opening ended in a commit. `onCancel` is the other exit, and
  // Radix reports both as the same close.
  const committed = useRef(false);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          committed.current = false;
          return;
        }
        if (!committed.current) {
          onCancel?.();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-label={ariaLabel ?? accessibleName}
          className={
            triggerVariant === ArtifactStatusVariant.Icon
              ? `flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted ${CHIP_FOCUS_RING_CLASS}`
              : "inline-flex items-center rounded-md px-1.5 py-0.5 hover:bg-muted"
          }
          id={triggerId}
          type="button"
        >
          {triggerVariant === ArtifactStatusVariant.Icon ? (
            <span aria-hidden>
              <ArtifactStatusMark
                variant={ArtifactStatusVariant.Icon}
                view={view}
              />
            </span>
          ) : (
            <ArtifactStatusMark
              variant={ArtifactStatusVariant.Display}
              view={view}
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {targetGroups.length > 0 ? (
          targetGroups.map((group) => (
            <DropdownMenuGroup
              aria-label={ARTIFACT_STATUS_DISPLAY_LABELS[group.root]}
              key={group.root}
            >
              {group.parents.length > 0 ? (
                group.parents.map(({ normalized, target }) => (
                  <ArtifactStatusTargetItem
                    key={target}
                    normalized={normalized}
                    onSelect={() => {
                      committed.current = true;
                      onCommit(buildSingleSubjectCommit(view, surface, target));
                    }}
                    target={target}
                    vocabulary={view.vocabulary}
                  />
                ))
              ) : (
                <ArtifactStatusTargetParentLabel
                  root={group.root}
                  vocabulary={view.vocabulary}
                />
              )}
              {group.children.map(({ normalized, target }) => (
                <ArtifactStatusTargetItem
                  key={target}
                  normalized={normalized}
                  onSelect={() => {
                    committed.current = true;
                    onCommit(buildSingleSubjectCommit(view, surface, target));
                  }}
                  target={target}
                  vocabulary={view.vocabulary}
                />
              ))}
            </DropdownMenuGroup>
          ))
        ) : (
          <DropdownMenuItem disabled>
            {NO_ALLOWED_TARGETS_COPY}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ArtifactStatusTargetItem({
  normalized,
  onSelect,
  target,
  vocabulary,
}: Readonly<{
  normalized: NormalizedArtifactStatus;
  onSelect: () => void;
  target: ArtifactStatusRawValue;
  vocabulary: ArtifactStatusVocabulary;
}>) {
  const facet = {
    normalized,
    raw: target,
    vocabulary,
  };
  const label = artifactStatusLabel(facet);
  return (
    <DropdownMenuItem
      aria-label={
        normalized.detail ? artifactStatusFullLabel(facet) : undefined
      }
      className={normalized.detail ? "ml-3 border-l pl-3" : undefined}
      onSelect={onSelect}
    >
      {!normalized.detail && (
        <StatusAppearanceIcon
          appearance={resolveArtifactStatusMark(facet).appearance}
          aria-hidden="true"
          label={label}
          size={16}
        />
      )}
      {label}
    </DropdownMenuItem>
  );
}

/** Canonical user-facing explanation for one status write refusal. */
export function artifactStatusReadOnlyReasonCopy(
  reason: ArtifactStatusReadOnlyReason
): string {
  if (
    reason !== ReadOnlyReason.UnrecognizedStatus &&
    Object.hasOwn(ARTIFACT_STATUS_READ_ONLY_COPY, reason)
  ) {
    return ARTIFACT_STATUS_READ_ONLY_COPY[reason];
  }
  return READ_ONLY_FALLBACK_COPY;
}

/**
 * `ArtifactStatusCommitFor<S>` is a conditional type, and `S` is still a naked
 * type parameter here, so `tsc` defers it and cannot see that
 * `ArtifactStatusSingleSubjectEditSurface` only ever selects the non-grouped
 * arm. The one assertion in this file is contained here rather than repeated at
 * each call site.
 */
function buildSingleSubjectCommit<
  S extends ArtifactStatusSingleSubjectEditSurface,
>(
  view: ArtifactStatusView,
  surface: S,
  to: ArtifactStatusRawValue
): ArtifactStatusCommitFor<S> {
  return {
    artifactId: view.artifactId,
    from: view.raw,
    surface,
    to,
    vocabulary: view.vocabulary,
  } as ArtifactStatusCommitFor<S>;
}

function ArtifactStatusTargetParentLabel({
  root,
  vocabulary,
}: Readonly<{
  root: ArtifactStatusRoot;
  vocabulary: ArtifactStatusVocabulary;
}>) {
  const facet = { normalized: { root }, raw: null, vocabulary };
  return (
    <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1.5 font-normal text-sm">
      <StatusAppearanceIcon
        appearance={resolveArtifactStatusMark(facet).appearance}
        aria-hidden="true"
        label={ARTIFACT_STATUS_DISPLAY_LABELS[root]}
        size={16}
      />
      {ARTIFACT_STATUS_DISPLAY_LABELS[root]}
    </DropdownMenuLabel>
  );
}
