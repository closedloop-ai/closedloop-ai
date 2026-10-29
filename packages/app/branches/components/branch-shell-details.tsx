"use client";

import {
  ArtifactStatusReadOnlyReason,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { observedPullRequestState } from "@repo/api/src/types/branch-associated-pull-request";
import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import {
  type BranchCollaborators,
  branchPersonKey,
} from "@repo/api/src/types/branch-identity";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import type { CollaboratorPerson } from "@repo/app/shared/components/collaborators";
import type { LinkedArtifactTableGroup } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-linked-artifacts-table";
import {
  CellText,
  LinkPillCell,
  PartialValueCell,
  personValue,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-cells";
import {
  type DetailsConfig,
  type DetailsField,
  DetailsFieldId,
  type DetailsFieldValue,
  DetailsRowFlag,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { PullRequestDetailsCell } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-cells";
import {
  DetailsTabArtifactType,
  shippedDetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { artifactStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { formatDateForInput } from "@repo/app/shared/lib/date-utils";
import {
  automaticField,
  copyField,
  countField,
  dateTimeField,
  notYetWritableField,
} from "@repo/app/shared/lib/details-field-constructors";
import { formatCostPreciseOrDash } from "@repo/app/shared/lib/format-utils";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import type { QueryClient } from "@tanstack/react-query";
import { useBranchesQueryContextOptional } from "../data-source/provider";
import { useBranchShellCollaborators } from "../hooks/use-branch-shell-collaborators";
import {
  type BranchDetailPerDollar,
  resolveBranchDetailPerDollar,
} from "../lib/branch-detail-per-dollar";
import {
  type DisplayableBranchMetricValue,
  displayableBranchMetricValue,
} from "../lib/branch-metric-value";
import { isGithubPrUrl } from "../lib/branch-pr-url";
import {
  deriveLifecycleBadge,
  type LifecycleBadge,
} from "../lib/merge-status-derivation";
import type { PreferredBranchLoc } from "../lib/preferred-branch-loc";
import {
  BranchChecksStatusValue,
  hasBranchChecksStatusValue,
} from "./branch-checks-status-value";
import { BranchLinkedArtifactGroupsScope } from "./branch-linked-artifact-groups-scope";
import { BranchShellCustomFieldRows } from "./branch-shell-details-custom-fields";
import { automaticTextField } from "./branch-shell-details-fields";
import {
  branchPriorityRow,
  branchProjectRow,
  branchTagsRow,
} from "./branch-shell-details-write-rows";
import { BranchUnavailableValue } from "./branch-unavailable-value";
import { LifecycleBadgeChip } from "./detail/branch-pr-status-panel";

/**
 * ISS-12197's Branch field set, in the ticket's order and wording: the generic
 * artifact fields, then the Branch fields — the order `branchDetailsConfig`
 * (the design fixture) draws. Owner is the artifact's assignee and Created by
 * its creator (decision 6, 2026-10-07); the Branches list's `owner` reads the
 * same assignee (ISS-12463).
 */

export const unavailableLabel = "Unavailable";
/**
 * A partial list is NOT an absent one. `Unavailable` here denied three people
 * who were on screen beside it; the projection already refuses to say
 * "unavailable" about a non-empty list (`artifact-collaborators.ts` downgrades
 * Unavailable to Incomplete the moment anyone resolves), and this label was
 * undoing that at the last step. Operator ruling, 2026-10-07.
 */
export const incompleteLabel = "Incomplete";

type BranchShellDetailsProps = {
  detail: BranchPageDetail;
  /** The page's artifact route builder; without one the Parent pill is inert. */
  getArtifactHref?: (slug: string) => string | null;
  /** The page's session route builder; without one a session row is inert. */
  getSessionHref?: (sessionArtifactId: string) => string;
  /**
   * Resolved once by the page so every panel shows one number. Presence is the
   * signal, exactly as `BranchPropertiesPanel` reads it: a present `loc` whose
   * halves are null means the page resolved no LOC, which must not fall back
   * to the raw detail columns.
   */
  loc?: PreferredBranchLoc;
};

/** Real Branch data mapped into the approved shared Details renderer. */
export function BranchShellDetails(props: BranchShellDetailsProps) {
  const { collaborators } = useBranchShellCollaborators(props.detail.id);
  // ISS-12452: the Tags row writes through the same Branch-owned client its
  // own reads are cached in — desktop injects one, distinct from the ambient
  // client the tag mutations default to. See `branchTagsRow`. The OPTIONAL
  // resolution (never throws) because this component mounts in tests and
  // Storybook with no `QueryClientProvider` ancestor at all.
  const { queryClient } = useBranchesQueryContextOptional();
  return (
    <BranchShellCustomFieldRows detail={props.detail}>
      {(customFieldRows) => (
        <BranchLinkedArtifactGroupsScope hosts={props}>
          {(linked, linkedFailed) => (
            <DetailsTabSections
              config={shippedDetailsTabConfig(
                DetailsTabArtifactType.Branch,
                branchShellDetailsConfig(
                  props,
                  collaborators,
                  customFieldRows,
                  linked,
                  linkedFailed,
                  queryClient ?? undefined
                )
              )}
              priorityEditor={ArtifactPriorityEditor}
            />
          )}
        </BranchLinkedArtifactGroupsScope>
      )}
    </BranchShellCustomFieldRows>
  );
}

export function branchShellDetailsConfig(
  props: BranchShellDetailsProps,
  collaborators: BranchCollaborators,
  /** ISS-12302: from `BranchShellCustomFieldRows`. */
  customFieldRows: readonly DetailsField[] = [],
  /** From `BranchLinkedArtifactGroupsScope`; empty draws no table. */
  linked: readonly LinkedArtifactTableGroup[] = [],
  /** The links read failed: the section says Unavailable (Kerensa Whitlock 2026-10-09). */
  linkedFailed = false,
  /** See `branchTagsRow` (ISS-12452). */
  queryClient?: QueryClient
): DetailsConfig {
  const { detail } = props;
  const field = DetailsFieldId;
  const collaboratorList = collaboratorPeople(collaborators);
  // ISS-12273 dropped the partial-list note (operator ruling, 2026-10-08), so
  // one shape serves every availability. `availability` still travels: an empty
  // list the producer could not read in full draws the unknown glyph, not an
  // empty stack.
  const people: DetailsFieldValue = {
    kind: "people",
    people: collaboratorList,
    availability: collaborators.availability,
  };
  // The per-branch attributed figure the Branches list shows (decision 3,
  // 2026-10-07); `null` is a cost nobody could price, so the row is left out.
  const cost = resolveAttributedBranchCost(detail);
  // The ticket's row is LOC, so only the LOC numerator sits under it; the
  // headline card's Pensero swap (ISS-9814) names its own label and does not
  // apply here.
  const perDollar = resolveBranchDetailPerDollar(detail.canonicalMetrics, {
    penseroPointsEnabled: false,
    populationMatched: false,
  });
  const locPerDollar = displayableBranchMetricValue(perDollar.result);

  return {
    core: [
      automaticField(field.Name, "Name", {
        kind: "text",
        mono: true,
        text: detail.branchName,
      }),
      copyField(field.Slug, "Slug", detail.slug),
      notYetWritableField(field.Owner, "Owner", personValue(detail.assignee)),
      automaticField(field.Collaborators, "Collaborators", people),
      automaticField(field.Status, "Status", {
        kind: "status",
        reason: ArtifactStatusReadOnlyReason.ProviderDerived,
        view: artifactStatusView(
          detail.artifactId ?? detail.id,
          ArtifactStatusVocabulary.Branch,
          detail.status
        ),
      }),
      ...branchPriorityRow(detail),
      // The renderer's `date` is a viewer-local `yyyy-mm-dd` (its picker writes
      // local midnight), so the instant is formatted in the viewer's zone, as
      // the Session host does, never sliced off its UTC day.
      notYetWritableField(field.DueDate, "Due date", {
        kind: "date",
        date: detail.dueDate ? formatDateForInput(detail.dueDate) : null,
      }),
      dateTimeField(field.CreatedAt, "Created at", detail.createdAt),
      automaticField(
        field.CreatedBy,
        "Created by",
        personValue(detail.createdBy)
      ),
      dateTimeField(field.Updated, "Updated at", detail.updatedAt),
      ...branchProjectRow(detail),
      parentField(props),
      ...branchTagsRow(detail, queryClient),
      automaticTextField(
        field.Repository,
        "Repository",
        detail.repoFullName,
        true
      ),
      pullRequestField(detail),
      automaticField(field.ChecksStatus, "Checks status", {
        kind: "custom",
        empty: !hasBranchChecksStatusValue(detail),
        render: () => (
          <CellText>
            <BranchChecksStatusValue
              checksPassed={detail.checksPassed}
              checksStatus={detail.checksStatus}
              checksTotal={detail.checksTotal}
            />
          </CellText>
        ),
      }),
      changesField(props),
      countField(
        field.CommitCount,
        "Commit count",
        detail.commits.length,
        COMMIT_NOUN
      ),
      automaticTextField(
        field.Cost,
        "Estimated cost",
        cost == null ? "" : formatCostPreciseOrDash(cost)
      ),
      locPerDollarField(perDollar, locPerDollar),
    ],
    customFields: customFieldRows,
    linkRows: [],
    linked,
    ...(linkedFailed ? { linkedUnavailable: unavailableLabel } : {}),
    // Host wording, reused verbatim from the Session shell Details host so the
    // two surfaces give one answer for the same refusal.
    viewerReasons: {
      "desktop-offline": unavailableLabel,
      "no-permission": unavailableLabel,
    },
    saveErrorLabel: INLINE_EDIT_SAVE_ERROR_MESSAGE,
    readOnlyName: (label, reason) => `${label}: ${reason}`,
  };
}

/**
 * The Details tab's composite Pull request cell (ISS-12252): number, title and
 * the Artifact tab's chip component, stating the pull request's own state.
 * One pull request describes the whole cell: on a multi-PR branch the selected
 * one supplies number, title and link, so #12 never wears #15's chip. An open
 * draft reads Draft; a closed or merged draft keeps its state and the Draft
 * flag beside it (ISS-12197's "draft flag"). A pull request nobody observed
 * reads "Status unavailable", never the column's placeholder OPEN (ISS-8422).
 */
function pullRequestField(
  detail: BranchPageDetail
): DetailsField<DetailsFieldId> {
  const selected = detail.selectedPullRequest;
  const number = selected?.number ?? detail.prNumber;
  // The branch's own columns may name a different pull request than the
  // selection, so they fill a gap only when they describe the same one.
  const columns =
    !selected || detail.prNumber === selected.number ? detail : null;
  const url = selected?.url ?? columns?.prUrl ?? null;
  const title = selected?.title ?? columns?.prTitle ?? "";
  return automaticField(DetailsFieldId.PullRequests, "Pull Request", {
    kind: "custom",
    empty: number == null,
    render: () =>
      number == null ? (
        <GridEmptyValue />
      ) : (
        <PullRequestDetailsCell
          pullRequest={{
            href: isGithubPrUrl(url) ? url : null,
            number,
            state: (
              <span className="inline-flex items-center gap-1">
                {pullRequestLifecycleBadges(detail).map((badge) => (
                  <LifecycleBadgeChip badge={badge} key={badge.label} />
                ))}
              </span>
            ),
            title,
          }}
        />
      ),
  });
}

function pullRequestLifecycleBadges(
  detail: BranchPageDetail
): LifecycleBadge[] {
  const selected = detail.selectedPullRequest;
  const prState = selected
    ? observedPullRequestState(selected)
    : detail.prState;
  const draft = deriveLifecycleBadge({
    persisted: { prState: null, status: BranchStatus.Draft },
  });
  if (selected?.isDraft && prState === GitHubPRState.Open) {
    return [draft];
  }
  const state = deriveLifecycleBadge({ persisted: { prState, status: null } });
  return selected?.isDraft ? [state, draft] : [state];
}

/** The artifact that PRODUCES this branch, as the fixture's link pill. */
function parentField(
  props: BranchShellDetailsProps
): DetailsField<DetailsFieldId> {
  const { parent } = props.detail;
  return automaticField(DetailsFieldId.Parent, "Parent", {
    kind: "custom",
    empty: !parent,
    render: () =>
      parent ? (
        <LinkPillCell
          item={{
            href: parent.slug
              ? (props.getArtifactHref?.(parent.slug) ?? null)
              : null,
            label: parent.slug ?? parent.name,
          }}
        />
      ) : (
        <GridEmptyValue />
      ),
  });
}

/**
 * Absence is not zero: a producer that measured no diff and one too old to
 * report one must not both read "+0 −0".
 */
function changesField(
  props: BranchShellDetailsProps
): DetailsField<DetailsFieldId> {
  const { detail, loc } = props;
  const additions = loc ? loc.additions : detail.additions;
  const deletions = loc ? loc.deletions : detail.deletions;
  if (additions == null || deletions == null) {
    // `empty: false` keeps the row drawn: `isDetailsFieldDrawn` omits an
    // automatic read-only field whose value is empty, so an `empty: true`
    // render arm is never reached on this tab and the row vanishes — which
    // the flag-off `BranchPropertiesPanel` does not do.
    return automaticField(DetailsFieldId.Changes, "Changes", {
      kind: "custom",
      empty: false,
      render: () => <BranchUnavailableValue />,
    });
  }
  return automaticField(DetailsFieldId.Changes, "Changes", {
    additions,
    deletions,
    kind: "changes",
  });
}

/**
 * Carries a provider-qualified KEY, not just names: the shared widget dedupes
 * on it, so one human reported by two sources is one avatar while two users who
 * share a display name stay two people (PR #8461). Same shape
 * `BranchShellCollaborators` builds for the header, off the same helper.
 */
function collaboratorPeople(
  collaborators: BranchCollaborators
): CollaboratorPerson[] {
  return collaborators.people.map((person) => ({
    key: branchPersonKey(person),
    name: person.displayName ?? person.login ?? person.id,
    ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
  }));
}

/**
 * The headline card's own rendering of the same figure
 * (`branch-headline-cards.tsx`): a Partial value keeps the card's `*` and its
 * disclosure opens from the row's info popover (branches AGENTS.md,
 * ISS-10540), so the row never says less than the card about the same number.
 * ISS-10667's one-label-per-metric gate is honored through `flaggedLabel`,
 * read at the row — and by the popover's name, through the same resolver.
 */
function locPerDollarField(
  perDollar: BranchDetailPerDollar,
  locPerDollar: DisplayableBranchMetricValue | null
): DetailsField<DetailsFieldId> {
  const row: Pick<DetailsField<DetailsFieldId>, "flaggedLabel" | "label"> = {
    flaggedLabel: {
      flag: DetailsRowFlag.OneLabelPerMetric,
      label:
        LOC_METRIC_DEFINITION[LocMetricDefinitionId.BranchDetailPublicationLoc]
          .canonicalLabel,
    },
    label: "LOC / $",
  };
  const text = locPerDollar ? perDollar.format(locPerDollar.value) : "";
  const disclosure = locPerDollar?.partial
    ? locPerDollar.disclosure
    : undefined;
  const value: DetailsFieldValue = disclosure
    ? {
        kind: "custom",
        render: () => (
          <PartialValueCell
            disclosure={disclosure}
            mono
            row={row}
            text={text}
          />
        ),
      }
    : { kind: "text", mono: true, text };
  return {
    ...automaticField(DetailsFieldId.LocPerDollar, row.label, value),
    ...row,
  };
}

/** The count cells' nouns, from the ticket's row labels. */
const COMMIT_NOUN: CountNoun = { one: "commit", other: "commits" };
