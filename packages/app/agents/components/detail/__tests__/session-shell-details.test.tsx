import {
  CollaboratorArtifactType,
  type SessionCollaborators,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { Priority } from "@repo/api/src/types/common";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag";
import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { getSessionSyncStatus } from "@repo/app/agents/lib/session-sync-status";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import {
  DetailsFieldId,
  DetailsReadOnlyKind,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { detailsReadOnlyWording } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-sections";
import {
  DETAILS_TAB_FIELD_GROUPS_SELECTOR,
  DetailsTabArtifactType,
  shippedDetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { automaticReason } from "@repo/app/shared/lib/details-lock-copy";
import { SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { TRACE_PREFIX_COUNTED_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_TRANSCRIPT_FILE_KEY } from "../../../lib/session-transcript-href";
import { resolveSubagentCount } from "../../../lib/subagent-transcripts";
import { SessionStatusBadge } from "../../session-status-badges";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { formatSessionLocPerDollar } from "../detail-content";
import {
  SessionShellDetails,
  sessionShellDetailsConfig,
} from "../session-shell-details";
import { resolveSessionAutonomyExplanation } from "../values/session-autonomy-value";
import { SessionDurationValue } from "../values/session-duration-value";

const ORIGINAL_TIME_ZONE = process.env.TZ;

const flags = vi.hoisted(() => ({
  neverExpected: false,
  reportedCost: false,
  tags: false,
  universalStatus: false,
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => {
    if (key === SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY) {
      return flags.neverExpected;
    }
    if (key === UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY) {
      return flags.universalStatus;
    }
    if (key === SESSIONS_ARTIFACT_TAGS_FLAG_KEY) {
      return flags.tags;
    }
    if (key === SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY) {
      return flags.reportedCost;
    }
    return false;
  },
}));

const collaboratorsRead = vi.hoisted(
  (): { collaborators: SessionCollaborators | null } => ({
    collaborators: null,
  })
);
vi.mock("../../../hooks/use-session-shell-collaborators", () => ({
  useSessionShellCollaborators: () => ({
    collaborators: collaboratorsRead.collaborators,
  }),
}));

// The linked-artifacts read is covered in
// `session-shell-details-linked-artifacts.test.tsx`; here it stays pending.
vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useResolvedArtifactLinks: () => ({ data: undefined, isPending: true }),
}));

const session = createAgentSessionDetailFixture();
const unavailable = unavailableArtifactCollaborators(
  CollaboratorArtifactType.Session
);

/**
 * ISS-12197's Session rows, in the ticket's order and wording, re-typed here
 * so a relabelled or moved row fails (the same policing
 * `details-sections.test.tsx` does for the fixture). Tags ships behind its
 * flag, read at the row.
 *
 * Sync and the LOC/$ ratio joined the set on the operator's instruction
 * (2026-10-08, ISS-12269) when the Properties card came off the Session page,
 * each keeping the neighbour it had on that card. The ratio's label is read
 * from the LOC definition registry, never re-typed, so this list cannot
 * disagree with the row about what the metric is called.
 */
const ZERO_RATIO_PATTERN = /^0(\.0+)?$/;

const ARTIFACT_DETAILS_LABELS = [
  "Name",
  "Slug",
  "Owner",
  "Collaborators",
  "Status",
  "Priority",
  "Due date",
  "Created at",
  "Created by",
  "Updated at",
  "Project",
  "Tags",
] as const;

/** One section, no Usage/Code sub-headers, Sync among the session's own rows. */
const SESSION_DETAILS_LABELS = [
  "Session ID",
  "Autonomy",
  "Harness",
  "Model",
  "Repository",
  "Other repositories",
  "Sync",
  "Started at",
  "Last active at",
  "Duration",
  "Input tokens",
  "Output tokens",
  "Cache read tokens",
  "Cache write tokens",
  "Estimated cost",
  LOC_METRIC_DEFINITION[LocMetricDefinitionId.SessionDetailMergedLoc].label,
  "Number of subagents",
  "Number of tool calls",
  "Number of errors",
] as const;

/** The cloud read: every Artifact-row field served, so every row has a value. */
const cloudSession = createAgentSessionDetailFixture({
  createdAt: "2026-06-10T11:58:00.000Z",
  createdBy: {
    avatarUrl: null,
    email: "grace@example.com",
    firstName: "Grace",
    id: "user-creator",
    lastName: "Hopper",
  },
  dueDate: "2026-06-20T00:00:00.000Z",
  // ISS-12269: the Sync row states a verdict or is not drawn, so the fixture
  // that pins the full row set has to carry sync evidence.
  lastSyncedAt: new Date("2026-06-10T12:20:00.000Z"),
  // ISS-10995: Priority and Tags draw only where the producer served them, so
  // the fixture that pins the full row set has to carry both — the same reason
  // it carries sync evidence above. The cloud read always serves them
  // (`projections.ts`; `projectArtifactTags` emits an availability either way).
  priority: Priority.Medium,
  tagAvailability: ArtifactTagAvailability.Available,
  tags: [{ color: TagColor.Blue, id: "tag-1", name: "platform" }],
  recordUpdatedAt: new Date("2026-06-10T12:19:00.000Z"),
  untrackedRepositoryTargets: [
    {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/docs",
      branchName: "docs/session-details",
    },
  ],
});

function renderDetails(
  detail = cloudSession,
  collaborators = unavailable,
  props: Partial<Parameters<typeof sessionShellDetailsConfig>[0]> = {}
) {
  return render(
    <AppCoreStoryProviders>
      <TooltipProvider>
        <DetailsTabSections
          config={shippedDetailsTabConfig(
            DetailsTabArtifactType.Session,
            sessionShellDetailsConfig(
              {
                session: detail,
                displayedStatus: SESSION_STATUS.INACTIVE,
                ...props,
              },
              collaborators,
              // The production fold, not a literal: the row and this test cannot
              // disagree about what the verdict reads.
              getSessionSyncStatus(detail).valueLabel ?? null
            )
          )}
          priorityEditor={ArtifactPriorityEditor}
        />
      </TooltipProvider>
    </AppCoreStoryProviders>
  );
}

/** Every field row's label, section after section, in drawn order. */
function coreLabels(): string[] {
  return Array.from(
    document.querySelectorAll(
      `${DETAILS_TAB_FIELD_GROUPS_SELECTOR} [role="group"]`
    )
  ).map((row) => (row.firstElementChild?.textContent ?? "").trim());
}

/** The value half of a drawn row (its first child is the label). */
function cellOf(id: DetailsFieldId): HTMLElement {
  const cell = document.querySelector<HTMLElement>(
    `[data-details-field="${id}"]`
  )?.lastElementChild;
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`Expected a drawn ${id} row`);
  }
  return cell;
}

/**
 * A cell's VISIBLE text, with the `sr-only` lock-reason span stripped out
 * (ISS-12470 added it to every `automaticField` row) — otherwise a strict
 * equality check on a locked row's `.textContent` picks up the hidden
 * reason sentence alongside the printed value.
 */
function visibleCellText(id: DetailsFieldId): string {
  const clone = cellOf(id).cloneNode(true) as HTMLElement;
  for (const srOnly of clone.querySelectorAll(".sr-only")) {
    srOnly.remove();
  }
  return clone.textContent ?? "";
}

/** Each drawn section's title and its rows' labels, in drawn order. */
function sections(): [string, string[]][] {
  return Array.from(document.querySelectorAll("[data-details-group]")).map(
    (group) => [
      group.querySelector("h2")?.textContent ?? "",
      Array.from(group.querySelectorAll('[role="group"]')).map((row) =>
        (row.firstElementChild?.textContent ?? "").trim()
      ),
    ]
  );
}

describe("Session shared Details mapping", () => {
  afterEach(() => {
    restoreTimeZone(ORIGINAL_TIME_ZONE);
    collaboratorsRead.collaborators = null;
    flags.neverExpected = false;
    flags.reportedCost = false;
    flags.tags = false;
    flags.universalStatus = false;
  });

  it("owns the `.sd3-details` scope its chip rules are styled under", () => {
    collaboratorsRead.collaborators = unavailable;
    render(
      <AppCoreStoryProviders>
        <TooltipProvider>
          <SessionShellDetails
            displayedStatus={SESSION_STATUS.INACTIVE}
            session={cloudSession}
          />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );
    expect(
      cellOf(DetailsFieldId.OtherRepositories).closest(".sd3-details")
    ).not.toBeNull();
  });

  it("draws the Details tab's sections: Artifact details, then Session details, with no Branch, Pull request or Lines changed row (ISS-12412)", () => {
    flags.tags = true;
    renderDetails();
    expect(sections()).toEqual([
      ["Artifact details", [...ARTIFACT_DETAILS_LABELS]],
      ["Session details", [...SESSION_DETAILS_LABELS]],
    ]);
  });

  it("keeps absent producer fields unknown and maps only actual custom fields", () => {
    const config = sessionShellDetailsConfig(
      { session, displayedStatus: SESSION_STATUS.INACTIVE },
      unavailable
    );
    const updated = config.core.find(
      (field) => field.id === DetailsFieldId.Updated
    );
    expect(updated?.value).toMatchObject({ kind: "custom", empty: true });
    expect(config.customFields).toEqual([]);
    // ISS-10995 (operator ruling 2026-10-09): a producer that served no tag
    // relation draws no Tags row, where this once asserted a dash cell.
    expect(
      config.core.find((field) => field.id === DetailsFieldId.Tags)
    ).toBeUndefined();
    expect(config.linked).toEqual([]);
  });

  it("leaves out Due date, Created at and Created by when the producer omits them, while unset writable rows stay drawn (ISS-12197)", () => {
    // The desktop local producer (`shared-agent-session-detail-projection.ts`)
    // omits Due date, and omits Created at and Created by for a NULL
    // `sessions.created_at` or an unresolved creator (ISS-12251); the fixture
    // omits all three.
    // PR #8555 review: Priority, Owner and Project are PATCH fields, so an
    // unset one stays drawn on this read-only tab.
    renderDetails(
      createAgentSessionDetailFixture({
        priority: null,
        project: null,
        user: null,
      })
    );
    const labels = coreLabels();
    for (const absent of ["Due date", "Created at", "Created by"]) {
      expect(labels).not.toContain(absent);
    }
    for (const drawn of ["Owner", "Priority", "Project"]) {
      expect(labels).toContain(drawn);
    }
  });

  it("marks only the fields production never writes as never-written", () => {
    const config = sessionShellDetailsConfig(
      { session, displayedStatus: SESSION_STATUS.INACTIVE },
      unavailable
    );
    const editOf = (id: DetailsFieldId) =>
      config.core.find((field) => field.id === id)?.edit;
    for (const id of [
      DetailsFieldId.Name,
      DetailsFieldId.Status,
      DetailsFieldId.Owner,
    ]) {
      expect(editOf(id)).toEqual({ mode: "read-only" });
    }
    // The counterfactual for ISS-10995: Priority and Tags left this set, and
    // this fixture serves neither, so they draw no row at all rather than an
    // unreasoned read-only one (operator ruling 2026-10-09). Project left it
    // too (operator ruling 2026-10-12) — this fixture DOES serve it, so it
    // draws, self-saving.
    for (const id of [DetailsFieldId.Priority, DetailsFieldId.Tags]) {
      expect(editOf(id)).toBeUndefined();
    }
    expect(editOf(DetailsFieldId.Project)).toEqual({ mode: "self-saving" });
    for (const id of [
      DetailsFieldId.Slug,
      DetailsFieldId.Collaborators,
      DetailsFieldId.CreatedAt,
      DetailsFieldId.CreatedBy,
      DetailsFieldId.Updated,
      DetailsFieldId.SessionId,
      DetailsFieldId.Autonomy,
      DetailsFieldId.Harness,
      DetailsFieldId.Model,
      DetailsFieldId.Repository,
      DetailsFieldId.OtherRepositories,
      DetailsFieldId.Started,
      DetailsFieldId.LastActive,
      DetailsFieldId.Duration,
      DetailsFieldId.InputTokens,
      DetailsFieldId.OutputTokens,
      DetailsFieldId.CacheReadTokens,
      DetailsFieldId.CacheWriteTokens,
      DetailsFieldId.Cost,
      DetailsFieldId.LocPerDollar,
      DetailsFieldId.SubagentCount,
      DetailsFieldId.ToolUseCount,
      DetailsFieldId.ErrorCount,
    ]) {
      expect(editOf(id)).toEqual({
        mode: "read-only",
        reason: {
          kind: DetailsReadOnlyKind.NotEditable,
          text: automaticReason,
        },
      });
    }
    // Due date is the one kind alone: it is user-ownable but outside the
    // editable set (ISS-12470), not a value the platform ever derives, so
    // "set automatically" would be untrue of it — matching Branch's
    // `notYetWritableField` treatment of the same field.
    expect(editOf(DetailsFieldId.DueDate)).toEqual({
      mode: "read-only",
      reason: { kind: DetailsReadOnlyKind.NotEditable },
    });
  });

  // The DRAWING half — that the tab renderer puts this wording in a tooltip —
  // is covered on both shells by `e2e/helpers/details-read-only-lock.ts`.
  it("resolves the automaticReason lock wording from the field config on every genuinely platform-derived row — and none on Owner or Due date (ISS-12470)", () => {
    const config = sessionShellDetailsConfig(
      { session, displayedStatus: SESSION_STATUS.INACTIVE },
      unavailable
    );
    const fieldOf = (id: DetailsFieldId) => {
      const field = config.core.find((candidate) => candidate.id === id);
      if (!field) {
        throw new Error(`Expected a core field for ${id}`);
      }
      return field;
    };
    for (const id of [
      DetailsFieldId.Slug,
      DetailsFieldId.Collaborators,
      DetailsFieldId.CreatedAt,
      DetailsFieldId.CreatedBy,
      DetailsFieldId.Updated,
      DetailsFieldId.SessionId,
      DetailsFieldId.Autonomy,
      DetailsFieldId.Harness,
      DetailsFieldId.Model,
      DetailsFieldId.Repository,
      DetailsFieldId.OtherRepositories,
      DetailsFieldId.Started,
      DetailsFieldId.LastActive,
      DetailsFieldId.Duration,
      DetailsFieldId.InputTokens,
      DetailsFieldId.OutputTokens,
      DetailsFieldId.CacheReadTokens,
      DetailsFieldId.CacheWriteTokens,
      DetailsFieldId.Cost,
      DetailsFieldId.LocPerDollar,
      DetailsFieldId.SubagentCount,
      DetailsFieldId.ToolUseCount,
      DetailsFieldId.ErrorCount,
    ]) {
      expect(detailsReadOnlyWording(fieldOf(id))?.text).toBe(automaticReason);
    }
    // Owner (no reason at all) and Due date (the kind alone) both resolve no
    // wording, for different reasons — the gate is what's pinned.
    for (const id of [DetailsFieldId.Owner, DetailsFieldId.DueDate]) {
      expect(detailsReadOnlyWording(fieldOf(id))).toBeNull();
    }
  });

  it("renders the generic artifact rows from the Artifact row's fields", () => {
    // The due date reads viewer-local; pinned so the fixture's midnight UTC
    // instant is the 20th wherever the suite runs.
    process.env.TZ = "UTC";
    renderDetails();
    expect(cellOf(DetailsFieldId.Slug)).toHaveTextContent("SES-1");
    expect(
      within(cellOf(DetailsFieldId.Slug)).getByRole("button", {
        name: "Copy slug",
      })
    ).toBeInTheDocument();
    // The fixture omits `assignee` (an older producer), so Owner falls back to
    // the session's user (ISS-12251 AC-012); Created by is the creator.
    expect(cellOf(DetailsFieldId.Owner)).toHaveTextContent("Ada Lovelace");
    expect(cellOf(DetailsFieldId.CreatedBy)).toHaveTextContent("Grace Hopper");
    expect(cellOf(DetailsFieldId.DueDate)).toHaveTextContent("2026-06-20");
    expect(cellOf(DetailsFieldId.CreatedAt)).toHaveTextContent("2026");
    expect(cellOf(DetailsFieldId.Updated)).toHaveTextContent("2026");
    expect(cellOf(DetailsFieldId.Project)).toHaveTextContent("Desktop MLP");
  });

  it("renders each Session row from the shared value it derives", () => {
    renderDetails();
    expect(
      within(cellOf(DetailsFieldId.SessionId)).getByRole("button", {
        name: "Copy session id",
      })
    ).toBeInTheDocument();
    expect(cellOf(DetailsFieldId.SessionId)).toHaveTextContent("ext-session-1");
    expect(cellOf(DetailsFieldId.Autonomy)).toHaveTextContent("82/100");
    expect(cellOf(DetailsFieldId.Harness)).toHaveTextContent("codex");
    expect(cellOf(DetailsFieldId.Model)).toHaveTextContent("gpt-5.5");
    expect(cellOf(DetailsFieldId.Repository)).toHaveTextContent(
      "closedloop-ai/closedloop-ai"
    );
    expect(cellOf(DetailsFieldId.OtherRepositories)).toHaveTextContent(
      "closedloop-ai/docs docs/session-details"
    );
    expect(cellOf(DetailsFieldId.Started)).toHaveTextContent("2026");
    expect(cellOf(DetailsFieldId.LastActive)).toHaveTextContent("2026");
    expect(cellOf(DetailsFieldId.InputTokens)).toHaveTextContent("12,000");
    expect(cellOf(DetailsFieldId.OutputTokens)).toHaveTextContent("3,200");
    expect(cellOf(DetailsFieldId.CacheReadTokens)).toHaveTextContent("900");
    expect(cellOf(DetailsFieldId.CacheWriteTokens)).toHaveTextContent("400");
    expect(cellOf(DetailsFieldId.Cost)).toHaveTextContent("$4.82");
    expect(cellOf(DetailsFieldId.SubagentCount)).toHaveTextContent("2");
    expect(cellOf(DetailsFieldId.ToolUseCount)).toHaveTextContent("5");
    expect(cellOf(DetailsFieldId.ErrorCount)).toHaveTextContent("1");
  });

  /*
   * ISS-12269 moved these two rows here off the Properties card. The card's own
   * cases went with it, so these are what stands between the move and a silent
   * regression: the verdict a session actually has, the absence that must not
   * draw an empty labelled row, and the ratio's not-applicable placeholder.
   */
  it("states the Sync verdict the production fold derives (ISS-12269)", () => {
    renderDetails();

    expect(cellOf(DetailsFieldId.Sync)).toHaveTextContent(
      getSessionSyncStatus(cloudSession).valueLabel as string
    );
  });

  it("draws no Sync row at all for a session with no sync verdict (ISS-12269)", () => {
    // Absent, not null: "this producer said nothing about sync", which is the
    // shape a session with no sync evidence actually arrives in. The base
    // fixture is synced, so every input the fold reads has to be cleared —
    // clearing only one leaves a verdict and the case proves nothing.
    const noVerdict = createAgentSessionDetailFixture({
      cloudSyncState: undefined,
      lastSyncedAt: undefined,
      transcriptDisposition: undefined,
    });
    // The premise: a row is omitted because there is nothing true to say, not
    // because the label was blanked. If the fold ever starts returning a label
    // here, this case is testing the wrong thing and should fail.
    expect(getSessionSyncStatus(noVerdict).valueLabel).toBeFalsy();

    renderDetails(noVerdict);

    expect(
      document.querySelector(`[data-details-field="${DetailsFieldId.Sync}"]`)
    ).toBeNull();
  });

  /*
   * ISS-7516's correction, graded through the COMPONENT rather than the config:
   * `renderDetails` hands the fold's answer straight in, so no case above can
   * reach `useSessionSyncValueLabel` or the override — delete the
   * `transcriptNeverExpected` prop and they all stay green while this tab
   * reads "Syncing" over a transcript the panel below says is never coming
   * (tamsinb review, PR #8612).
   */
  it("corrects the cloud's `syncing` verdict on the Sync row when the transcript is never coming (ISS-7516)", () => {
    flags.neverExpected = true;
    collaboratorsRead.collaborators = unavailable;
    const neverComing = createAgentSessionDetailFixture({
      transcriptDisposition: TranscriptDisposition.Syncing,
      transcripts: [
        {
          fileKey: MAIN_TRANSCRIPT_FILE_KEY,
          availability: TranscriptAvailability.Missing,
          uploadedAt: null,
          permanentFailureReason: null,
        },
      ],
    });
    // Both verdicts come from the production fold, and the premise is that they
    // DIFFER — otherwise the assertion below would hold with no override at all.
    const corrected = getSessionSyncStatus({
      cloudSyncState: neverComing.cloudSyncState,
      lastSyncedAt: neverComing.lastSyncedAt,
      transcriptDisposition: TranscriptDisposition.NeverExpected,
    }).valueLabel as string;
    const uncorrected = getSessionSyncStatus(neverComing).valueLabel as string;
    expect(uncorrected).toBeTruthy();
    expect(uncorrected).not.toBe(corrected);

    render(
      <AppCoreStoryProviders>
        <TooltipProvider>
          <SessionShellDetails
            displayedStatus={SESSION_STATUS.INACTIVE}
            session={neverComing}
            transcriptNeverExpected
          />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );

    const cell = cellOf(DetailsFieldId.Sync);
    expect(cell).toHaveTextContent(corrected);
    expect(cell).not.toHaveTextContent(uncorrected);
  });

  it("leaves the served verdict alone while the ISS-7516 flag is closed", () => {
    collaboratorsRead.collaborators = unavailable;
    const neverComing = createAgentSessionDetailFixture({
      transcriptDisposition: TranscriptDisposition.Syncing,
      transcripts: [
        {
          fileKey: MAIN_TRANSCRIPT_FILE_KEY,
          availability: TranscriptAvailability.Missing,
          uploadedAt: null,
          permanentFailureReason: null,
        },
      ],
    });

    render(
      <AppCoreStoryProviders>
        <TooltipProvider>
          <SessionShellDetails
            displayedStatus={SESSION_STATUS.INACTIVE}
            session={neverComing}
            transcriptNeverExpected
          />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );

    expect(cellOf(DetailsFieldId.Sync)).toHaveTextContent(
      getSessionSyncStatus(neverComing).valueLabel as string
    );
  });

  it("renders the LOC/$ ratio under the registry's own label (ISS-12269)", () => {
    renderDetails();

    expect(cellOf(DetailsFieldId.LocPerDollar)).toHaveTextContent(
      formatSessionLocPerDollar(cloudSession)
    );
  });

  it("never fabricates a LOC/$ figure it could not compute (ISS-12269)", () => {
    const uncomputable = createAgentSessionDetailFixture({
      locPerDollar: null,
    });

    renderDetails(uncomputable);

    const rendered = visibleCellText(DetailsFieldId.LocPerDollar);
    expect(rendered).toBe(formatSessionLocPerDollar(uncomputable));
    expect(rendered).not.toMatch(ZERO_RATIO_PATTERN);
  });

  it("counts subagents the way the Subagents card does: agentCount minus the main agent (PR #8585 review)", () => {
    // The fixture's three agent rows are one main agent and two subagents, so
    // the raw `agentCount` of 3 is the wrong figure here.
    expect(cloudSession.agentCount).toBe(3);
    expect(resolveSubagentCount(cloudSession)).toBe(2);
    renderDetails();
    const cell = cellOf(DetailsFieldId.SubagentCount);
    expect(cell).toHaveTextContent("2 subagents");
    expect(cell).not.toHaveTextContent("3");
  });

  it("reads the due date in the viewer's zone, not the UTC day (PR #8585 review)", () => {
    // 20:00 UTC on the 19th is already the 20th in Tokyo; the date picker
    // writes local midnight, so the viewer-local day is the one they set.
    process.env.TZ = "Asia/Tokyo";
    renderDetails(
      createAgentSessionDetailFixture({
        dueDate: "2026-06-19T20:00:00.000Z",
      })
    );
    const cell = cellOf(DetailsFieldId.DueDate);
    expect(cell).toHaveTextContent("2026-06-20");
    expect(cell).not.toHaveTextContent("2026-06-19");
  });

  it("carries the Properties row's truncation sentence on a prefix-scored Autonomy (PR #8585 review)", () => {
    const truncated = createAgentSessionDetailFixture({
      autonomy: 41,
      autonomyTruncated: true,
    });
    const sentence = resolveSessionAutonomyExplanation(truncated);
    expect(sentence).toContain(TRACE_PREFIX_COUNTED_NOTE);
    const prefixScored = renderDetails(truncated);
    const cell = cellOf(DetailsFieldId.Autonomy);
    expect(cell).toHaveTextContent("41/100");
    expect(cell).toHaveTextContent(sentence ?? "");
    prefixScored.unmount();

    renderDetails();
    expect(cellOf(DetailsFieldId.Autonomy)).not.toHaveTextContent(
      TRACE_PREFIX_COUNTED_NOTE
    );
  });

  it("draws the Estimated cost row for Claude's reported figure when the estimate is a dash (ISS-7229)", () => {
    flags.reportedCost = true;
    // Tokens recorded on an unpriced model: `CostAvailability.Unavailable`.
    renderDetails(
      createAgentSessionDetailFixture({
        authoritativeCostUsd: 3.21,
        billingMode: null,
        estimatedCost: 0,
      })
    );
    const cell = cellOf(DetailsFieldId.Cost);
    expect(cell).toHaveTextContent("$3.21");
    expect(cell).toHaveTextContent("Claude reported");
  });

  it("leaves out the Estimated cost row when neither figure exists", () => {
    renderDetails(
      createAgentSessionDetailFixture({
        billingMode: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
      })
    );
    expect(coreLabels()).not.toContain("Estimated cost");
  });

  it("shows the Duration the Properties row shows, from the one derivation", () => {
    render(
      <div data-testid="value">
        <SessionDurationValue session={cloudSession} />
      </div>
    );
    const expected = screen.getByTestId("value").textContent;
    expect(expected).not.toBe("");
    renderDetails();
    expect(cellOf(DetailsFieldId.Duration)).toHaveTextContent(expected ?? "");
  });

  it("pins per-counter token honesty: a measured zero renders, an unrecorded session draws no token row (ISS-5637)", () => {
    const recorded = renderDetails(
      createAgentSessionDetailFixture({ cacheWrite: 0 })
    );
    expect(cellOf(DetailsFieldId.CacheWriteTokens)).toHaveTextContent("0");
    recorded.unmount();
    renderDetails(
      createAgentSessionDetailFixture({
        cache: 0,
        cacheWrite: 0,
        tokensIn: 0,
        tokensOut: 0,
      })
    );
    const labels = coreLabels();
    for (const absent of [
      "Input tokens",
      "Output tokens",
      "Cache read tokens",
      "Cache write tokens",
    ]) {
      expect(labels).not.toContain(absent);
    }
  });

  /*
   * ISS-12273 removed the partial-list note (operator ruling, 2026-10-08), so
   * the disclosure half of the old case is obsolete. What survives, and is what
   * this now pins: `availability` still travels, because an empty list the
   * producer could not read in full must draw the unknown glyph rather than an
   * empty stack (`isDetailsValueEmpty` reads it).
   */
  it("carries source availability on a partial list, with no note", () => {
    const collaborators = {
      ...unavailable,
      availability: BranchIdentityAvailability.Incomplete,
      people: [],
    };
    const config = sessionShellDetailsConfig(
      { session, displayedStatus: SESSION_STATUS.INACTIVE },
      collaborators
    );
    expect(
      config.core.find((field) => field.id === DetailsFieldId.Collaborators)
        ?.value
    ).toEqual({
      kind: "people",
      availability: BranchIdentityAvailability.Incomplete,
      people: [],
    });
  });

  it("carries each collaborator's key, so two people sharing a name stay apart", () => {
    // whitlockk, #8461: the mapping reduced collaborators to display names, and the
    // stack deduped on those — two different users called "Alex Smith" became
    // one avatar and a count one short.
    const collaborators = {
      ...unavailable,
      availability: BranchIdentityAvailability.Complete,
      people: [
        {
          provider: BranchPersonProvider.ClosedLoop,
          id: "user_1",
          displayName: "Alex Smith",
        },
        {
          provider: BranchPersonProvider.ClosedLoop,
          id: "user_2",
          displayName: "Alex Smith",
        },
      ],
    };
    const config = sessionShellDetailsConfig(
      { session, displayedStatus: SESSION_STATUS.INACTIVE },
      collaborators
    );
    expect(
      config.core.find((field) => field.id === DetailsFieldId.Collaborators)
        ?.value
    ).toEqual({
      kind: "people",
      availability: BranchIdentityAvailability.Complete,
      people: [
        { key: "closedloop:user_1", name: "Alex Smith" },
        { key: "closedloop:user_2", name: "Alex Smith" },
      ],
    });
  });

  // ISS-10364 (operator ruling): an unparsable or absent raw status reads as
  // the displayed lifecycle status everywhere, so neither case says Unknown.
  it.each([
    [null, "Done · Completed"],
    [undefined, "Done · Completed"],
  ] as const)(
    "reads the displayed status for raw status %s in the universal Details badge",
    (rawStatus, label) => {
      flags.universalStatus = true;
      const statusSession = createAgentSessionDetailFixture({ rawStatus });
      const config = sessionShellDetailsConfig(
        { session: statusSession, displayedStatus: SESSION_STATUS.INACTIVE },
        unavailable
      );
      const value = config.core.find(
        (field) => field.id === DetailsFieldId.Status
      )?.value;
      if (value?.kind !== "custom") {
        throw new Error("Expected the canonical status value cell");
      }
      render(
        <TooltipProvider>
          <div data-testid="details-status">{value.render()}</div>
          <div data-testid="artifact-status">
            <SessionStatusBadge
              artifactId={statusSession.id}
              status={SESSION_STATUS.INACTIVE}
            />
          </div>
        </TooltipProvider>
      );
      expect(
        within(screen.getByTestId("details-status")).getByText(label)
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId("artifact-status")).getByText(label)
      ).toBeInTheDocument();
    }
  );
});
