"use client";

import type {
  AgentSessionDetail,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import type { SessionCollaborators } from "@repo/api/src/types/artifact-collaborators";
import { branchPersonKey } from "@repo/api/src/types/branch-identity";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import type { DisplayedSessionStatus } from "@repo/api/src/types/session-status";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import {
  type CollaboratorPerson,
  Collaborators,
} from "@repo/app/shared/components/collaborators";
import type { LinkedArtifactTableGroup } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-linked-artifacts-table";
import {
  CellText,
  personValue,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-cells";
import {
  type DetailsConfig,
  type DetailsField,
  DetailsFieldId,
  type DetailsFieldValue,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import {
  DetailsTabArtifactType,
  shippedDetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { formatDateForInput } from "@repo/app/shared/lib/date-utils";
import {
  automaticField,
  copyField,
  countField,
  dateTimeField,
  notYetWritableField,
  readOnlyField,
} from "@repo/app/shared/lib/details-field-constructors";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import { useSessionShellCollaborators } from "../../hooks/use-session-shell-collaborators";
import {
  claudeReportedCost,
  costLabelIsFigure,
  deriveCostAvailability,
  deriveSessionCostLabel,
  hasRecordedTokenUsage,
} from "../../lib/cost-availability";
import { resolveSessionOwner } from "../../lib/session-owner";
import { resolveSessionRepositoryFullName } from "../../lib/session-repository-label";
import { resolveSubagentCount } from "../../lib/subagent-transcripts";
import { SessionStatusBadge } from "../session-status-badges";
import { formatSessionLocPerDollar } from "./detail-content";
import {
  SessionCostValue,
  useSessionSyncValueLabel,
} from "./session-flagged-properties";
import { SessionLinkedArtifactGroupsScope } from "./session-linked-artifact-groups-scope";
import { useSessionLocPerDollarRowLabel } from "./session-loc-per-dollar-property";
import { SessionDetailsDurationCell } from "./session-shell-details-cells";
import { SessionShellCustomFieldRows } from "./session-shell-details-custom-fields";
import { derivedTextField, textField } from "./session-shell-details-fields";
import {
  priorityRow,
  sessionProjectRow,
  tagsRow,
} from "./session-shell-details-write-rows";
import {
  resolveSessionAutonomyExplanation,
  SessionAutonomyValue,
} from "./values/session-autonomy-value";
import { SessionOtherRepositoriesValue } from "./values/session-other-repositories-value";
import { SessionTokenCountValue } from "./values/session-token-count-value";

// Existing machine-written field wording from artifact-status-editor.
export const unavailableLabel = "Unavailable";

export type SessionShellDetailsProps = {
  session: AgentSessionDetail;
  displayedStatus: DisplayedSessionStatus;
  buildArtifactHref?: (artifact: SessionLinkedArtifact) => string | null;
  artifactHrefPending?: boolean;
  getBranchHref?: (branchArtifactId: string) => string;
  /** ISS-7516: see `SessionTranscriptPanel`'s prop of the same name. */
  transcriptNeverExpected?: boolean;
};

/** Real Session data mapped into the approved shared Details renderer. */
export function SessionShellDetails(props: SessionShellDetailsProps) {
  const { collaborators } = useSessionShellCollaborators(props.session.id);
  // ISS-12269 moved Sync here off the Properties card. Its label is also its
  // existence — `null` means this session has no sync verdict to state, not an
  // empty row — and resolving it needs the ISS-7516 flag, so it is read at this
  // one site and travels as a value rather than as a flag.
  const syncValueLabel = useSessionSyncValueLabel(
    props.session,
    props.transcriptNeverExpected
  );
  const locPerDollarLabel = useSessionLocPerDollarRowLabel();
  // `.sd3-details` scopes the Other repositories chip rules
  // (styles-session-detail-props.css); owned here, as `SessionPropertiesPanel`
  // owns `.sd3-props`, so every mount is styled.
  return (
    <div className="sd3-details">
      <SessionShellCustomFieldRows session={props.session}>
        {(customFieldRows) => (
          <SessionLinkedArtifactGroupsScope hosts={props}>
            {(linked, linkedFailed) => (
              <DetailsTabSections
                config={shippedDetailsTabConfig(
                  DetailsTabArtifactType.Session,
                  sessionShellDetailsConfig(
                    props,
                    collaborators,
                    syncValueLabel,
                    locPerDollarLabel,
                    customFieldRows,
                    linked,
                    linkedFailed
                  )
                )}
                priorityEditor={ArtifactPriorityEditor}
              />
            )}
          </SessionLinkedArtifactGroupsScope>
        )}
      </SessionShellCustomFieldRows>
    </div>
  );
}

/**
 * The header consumes the same source-scoped read as the Details row.
 *
 * ISS-12273 put this on the one shared `Collaborators` widget and dropped the
 * partial-list note with it (operator ruling, 2026-10-08) — the same two moves
 * ISS-12267 made on the Branch header, so the two read identically. Blank while
 * the read is pending, because the hook's pre-load placeholder is an
 * "unavailable" result that must not draw as a finished empty list.
 */
export function SessionShellCollaborators({
  sessionId,
}: {
  sessionId: string;
}) {
  const { collaborators, isPending } = useSessionShellCollaborators(sessionId);
  if (isPending) {
    return null;
  }
  return <Collaborators people={collaboratorPeople(collaborators)} />;
}

/**
 * ISS-12197's Session field set, in the ticket's order and wording: the
 * generic artifact fields, then the Session fields. Owner is the session's
 * assignee, as on every artifact type (ISS-12251 D-1, superseding the PR #8555
 * decision to keep it on `user`); Created by is the artifact's creator;
 * Sessions carry no Parent (decision 2, 2026-10-07).
 */
export function sessionShellDetailsConfig(
  props: SessionShellDetailsProps,
  collaborators: SessionCollaborators,
  /** Resolved by the caller; `null` draws no Sync row at all. */
  syncValueLabel: string | null = null,
  /** Resolved by the caller from the LOC definition registry. */
  locPerDollarLabel: string = LOC_METRIC_DEFINITION[
    LocMetricDefinitionId.SessionDetailMergedLoc
  ].label,
  /** ISS-12302: from `SessionShellCustomFieldRows`. */
  customFieldRows: readonly DetailsField[] = [],
  /** From `SessionLinkedArtifactGroupsScope`; empty draws no table. */
  linked: readonly LinkedArtifactTableGroup[] = [],
  /** The links read failed: the section says Unavailable (Kerensa Whitlock 2026-10-09). */
  linkedFailed = false
): DetailsConfig {
  const { session, displayedStatus } = props;
  const field = DetailsFieldId;
  const collaboratorStack = collaboratorPeople(collaborators);
  // ISS-12273 dropped the partial-list note (operator ruling, 2026-10-08), so
  // one shape serves every availability. `availability` still travels: an empty
  // list the producer could not read in full draws the unknown glyph, not an
  // empty stack.
  const people: DetailsFieldValue = {
    kind: "people",
    people: collaboratorStack,
    availability: collaborators.availability,
  };
  // ISS-5637: decided ONCE on the summed quadruple and handed to every counter,
  // so a measured per-counter zero inside a recorded session still renders.
  const usageRecorded = hasRecordedTokenUsage({
    inputTokens: session.tokensIn,
    outputTokens: session.tokensOut,
    cacheReadTokens: session.cache,
    cacheWriteTokens: session.cacheWrite,
  });
  const tokenField = (
    id: DetailsFieldId,
    label: string,
    value: number | null | undefined
  ) =>
    automaticField(id, label, {
      kind: "custom",
      empty: !usageRecorded || value == null,
      render: () => (
        <CellText>
          <SessionTokenCountValue usageRecorded={usageRecorded} value={value} />
        </CellText>
      ),
    });
  const untrackedRepositoryTargets = session.untrackedRepositoryTargets ?? [];
  // The Properties row's sentence (ISS-5636): on desktop a truncated read
  // scores only the loaded prefix, and the figure alone would claim the whole
  // session (whitlockk, PR #8585 review).
  const autonomyExplanation = resolveSessionAutonomyExplanation(session);
  return {
    core: [
      textField(field.Name, "Name", session.name),
      copyField(field.Slug, "Slug", session.slug),
      readOnlyField(
        field.Owner,
        "Owner",
        personValue(resolveSessionOwner(session))
      ),
      automaticField(field.Collaborators, "Collaborators", people),
      readOnlyField(field.Status, "Status", {
        kind: "custom",
        render: () => (
          <SessionStatusBadge
            artifactId={session.id}
            status={displayedStatus}
          />
        ),
      }),
      // ISS-12269 moved Sync here; the Details tab draws it among the session's
      // own rows (`DETAILS_TAB_TYPE_GROUPS.session`, approved 2026-10-08).
      automaticField(field.Sync, "Sync", {
        kind: "text",
        text: syncValueLabel ?? "",
      }),
      ...priorityRow(session),
      // `AGENT_SESSION_ROW_FIELD_EDIT.dueDate` is NotEditable — outside the
      // editable set (operator ruling 2026-10-09) — so an unset due date is
      // left out like any other never-written row. The renderer's `date` is a
      // viewer-local `yyyy-mm-dd` (its picker writes local midnight), so the
      // instant is formatted in the viewer's zone, as the documents grid does,
      // never sliced off its UTC day.
      notYetWritableField(field.DueDate, "Due date", {
        kind: "date",
        date: session.dueDate ? formatDateForInput(session.dueDate) : null,
      }),
      dateTimeField(field.CreatedAt, "Created at", session.createdAt),
      automaticField(
        field.CreatedBy,
        "Created by",
        personValue(session.createdBy)
      ),
      dateTimeField(field.Updated, "Updated at", session.recordUpdatedAt),
      ...sessionProjectRow(session),
      ...tagsRow(session),
      copyField(field.SessionId, "Session ID", session.externalSessionId),
      automaticField(field.Autonomy, "Autonomy", {
        kind: "custom",
        empty: session.autonomy == null,
        render: () => (
          <CellText className="flex-wrap gap-x-2">
            <SessionAutonomyValue session={session} />
            {autonomyExplanation ? (
              <span className="text-muted-foreground text-xs">
                {autonomyExplanation}
              </span>
            ) : null}
          </CellText>
        ),
      }),
      derivedTextField(field.Harness, "Harness", session.harness),
      derivedTextField(
        field.Model,
        "Model",
        session.primaryModel ?? session.model,
        true
      ),
      derivedTextField(
        field.Repository,
        "Repository",
        resolveSessionRepositoryFullName(session),
        true
      ),
      automaticField(field.OtherRepositories, "Other repositories", {
        kind: "custom",
        empty: untrackedRepositoryTargets.length === 0,
        render: () => (
          <CellText className="flex-wrap gap-1.5">
            <SessionOtherRepositoriesValue
              targets={untrackedRepositoryTargets}
            />
          </CellText>
        ),
      }),
      dateTimeField(field.Started, "Started at", session.startedAt),
      dateTimeField(field.LastActive, "Last active at", session.lastActivityAt),
      automaticField(field.Duration, "Duration", {
        kind: "custom",
        // The window itself needs `now`; a session that never started has no
        // span under any window.
        empty: session.startedAt == null,
        render: () => <SessionDetailsDurationCell session={session} />,
      }),
      tokenField(field.InputTokens, "Input tokens", session.tokensIn),
      tokenField(field.OutputTokens, "Output tokens", session.tokensOut),
      tokenField(field.CacheReadTokens, "Cache read tokens", session.cache),
      tokenField(
        field.CacheWriteTokens,
        "Cache write tokens",
        session.cacheWrite
      ),
      automaticField(field.Cost, "Estimated cost", {
        kind: "custom",
        // Drawn whenever `SessionCostValue` has a figure to print: our estimate
        // or Claude's reported cost (ISS-7229). The cell reads the reported-cost
        // gate; closed, it prints the estimate's dash, never hides a figure.
        empty: !(
          costLabelIsFigure(deriveCostAvailability(session)) ||
          claudeReportedCost(session) !== null
        ),
        render: () => (
          <CellText>
            <SessionCostValue
              estimate={deriveSessionCostLabel(session)}
              session={session}
            />
          </CellText>
        ),
      }),
      // ISS-12269: LOC/$ followed Estimated cost on the Properties card and
      // keeps that neighbour here. The label is `useSessionLocPerDollarRowLabel`
      // read at this component's top and the figure is the same
      // `formatSessionLocPerDollar` the Properties row prints, so the two
      // surfaces cannot state the ratio under different units or round it
      // differently.
      automaticField(field.LocPerDollar, locPerDollarLabel, {
        kind: "custom",
        render: () => (
          <CellText className="font-mono">
            {formatSessionLocPerDollar(session)}
          </CellText>
        ),
      }),
      // The Subagents metric card's expression: `agentCount` minus the main
      // agent, null while unknown (tamsinb, PR #8585 review).
      countField(
        field.SubagentCount,
        "Number of subagents",
        resolveSubagentCount(session),
        SUBAGENT_NOUN
      ),
      countField(
        field.ToolUseCount,
        "Number of tool calls",
        session.toolCallsTotal ?? session.toolUseCount,
        TOOL_CALL_NOUN
      ),
      countField(
        field.ErrorCount,
        "Number of errors",
        session.errorCount,
        ERROR_NOUN
      ),
    ],
    customFields: customFieldRows,
    // Branches and pull requests draw in the linked-artifacts table (PLN-2175
    // requirements 12 and 13).
    linkRows: [],
    linked,
    ...(linkedFailed ? { linkedUnavailable: unavailableLabel } : {}),
    viewerReasons: {
      "desktop-offline": unavailableLabel,
      "no-permission": unavailableLabel,
    },
    saveErrorLabel: INLINE_EDIT_SAVE_ERROR_MESSAGE,
    readOnlyName: (label, reason) => `${label}: ${reason}`,
  };
}

/**
 * Collaborators as {@link CollaboratorPerson}s, keyed on each person's own
 * provider-qualified key.
 *
 * Reducing them to display names let the stack's dedupe collapse two DIFFERENT
 * users who share one — two people called "Alex Smith" drew one avatar and a
 * count short by one (whitlockk review, PR #8461). The name is still what renders;
 * the key is only what identity is decided on.
 */
function collaboratorPeople(
  collaborators: SessionCollaborators
): CollaboratorPerson[] {
  return collaborators.people.map((person) => ({
    key: branchPersonKey(person),
    name: person.displayName ?? person.login ?? person.id,
    ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
  }));
}

/** The count cells' nouns, from the ticket's row labels. */
const SUBAGENT_NOUN: CountNoun = { one: "subagent", other: "subagents" };
const TOOL_CALL_NOUN: CountNoun = { one: "tool call", other: "tool calls" };
const ERROR_NOUN: CountNoun = { one: "error", other: "errors" };
