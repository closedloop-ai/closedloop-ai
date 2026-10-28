import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactStatusReadOnlyReason,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import type { Priority } from "@repo/api/src/types/common";
import { ISSUE_STATUS_OPTIONS } from "@repo/api/src/types/document";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPrioritySurface,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { artifactStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { PRIORITY_COLUMN_LABEL } from "@repo/app/shared/lib/priority-constants";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import { GitPullRequestIcon } from "lucide-react";
import { createElement, type ReactNode } from "react";
import { ArtifactTypeIcons } from "../components/artifact-icons";
import type {
  ArtifactLinkedRecord,
  LinkedArtifactTableGroup,
} from "../components/artifact-linked-artifacts-table";
import {
  LINKED_ARTIFACT_GROUP_HEADINGS,
  LINKED_ARTIFACT_RELATIONSHIP_LABELS,
  LinkEnd,
} from "../components/linked-artifact-groups";
import {
  CopyCell,
  DateTimeCell,
  DetailsCountCell,
  DurationCell,
  LinkPillCell,
  PillsCell,
} from "./details-design-cells";
import {
  type DetailsConfig,
  type DetailsDesignHost,
  type DetailsEditableValue,
  type DetailsField,
  type DetailsFieldEdit,
  DetailsFieldId,
  type DetailsFieldValue,
  DetailsReadOnlyKind,
  type DetailsReadOnlyValue,
  DetailsRowFlag,
} from "./details-design-model";

/**
 * ISS-10792 harness fixtures: what each type's host would hand the renderer.
 *
 * Session and Branch carry ISS-12197's field set in its order — the generic
 * artifact rows first, then the type's own — under its labels, verbatim
 * (decision 4, 2026-10-07), so the harness and the production hosts share one
 * order. A read-only row with no value is left in the config and hidden by
 * the renderer's empty-row rule; a flag-gated row ships behind its flag, read
 * at the row. Every id is fake, and fixture wording is labelled "Fixture:".
 */

export const FIXTURE_REPOSITORY = "fixture-org/fixture-repo";
export const FIXTURE_SESSION_ID = "00000000-0000-4000-8000-00000000a001";
export const FIXTURE_BRANCH_ID = "00000000-0000-4000-8000-00000000b001";
export const FIXTURE_PEOPLE = [
  "Alex Rivera",
  "Sam Lee",
  "Taylor Morgan",
  "Jordan Kim",
] as const;

export const FIXTURE_VIEWER_REASONS: DetailsConfig["viewerReasons"] = {
  "desktop-offline":
    "Fixture: You're offline. Changes can't be saved until the desktop app reconnects.",
  "no-permission": "Fixture: You can view these details but not change them.",
};

/** Shipped wording, reused (`org-policy-toggle-state.ts`). */
export const SAVE_ERROR_LABEL = INLINE_EDIT_SAVE_ERROR_MESSAGE;

/** Fixture wording for every not-editable reason; a real host supplies its own. */
export const FIXTURE_REASONS = {
  derivedPeople:
    "Fixture: Everyone who commented here, on its sessions or its pull request. Bots are left out.",
  fromGit: "Fixture: Read from git and the pull request.",
  fromHarness: "Fixture: Recorded by the agent harness.",
  fromProject: "Fixture: Set by the project the issue is filed in.",
  fromPullRequest: "Fixture: Set from the pull request.",
  fromRun: "Fixture: Set automatically by the run.",
  fromSessions: "Fixture: Counted from the sessions on this branch.",
  notYetWritable: "Fixture: Not editable here yet.",
  systemId: "Fixture: Assigned by Closedloop.",
} as const;

export const notEditable = (text: string) =>
  ({
    mode: "read-only",
    reason: { kind: DetailsReadOnlyKind.NotEditable, text },
  }) as const;
export const FROM_GIT = notEditable(FIXTURE_REASONS.fromGit);
export const FROM_SESSIONS = notEditable(FIXTURE_REASONS.fromSessions);
export const FROM_HARNESS = notEditable(FIXTURE_REASONS.fromHarness);
export const FROM_RUN = notEditable(FIXTURE_REASONS.fromRun);
export const SYSTEM_ID = notEditable(FIXTURE_REASONS.systemId);
export const DERIVED_PEOPLE = notEditable(FIXTURE_REASONS.derivedPeople);
/** The tab stays read-only (ISS-10796 ruling); the writes are ISS-10995's. */
export const NOT_YET_WRITABLE = notEditable(FIXTURE_REASONS.notYetWritable);
export const FIXTURE_INCOMPLETE_NOTE = "Fixture: some sources not read yet";
/** Fixture wording for a read-only row's accessible name. */
export const fixtureReadOnlyName = (label: string, reason: string) =>
  `Fixture: ${label} is read-only. ${reason}`;

const fakeSave = (next: DetailsFieldValue) =>
  new Promise<void>((resolve) => {
    // A design-harness stand-in for ISS-10995's write; it only pauses so the
    // saving state is visible.
    setTimeout(resolve, 600, next);
  });

export const editable = () =>
  ({ mode: "editable", onSave: fakeSave }) as const satisfies DetailsFieldEdit;
type ReadOnlyEdit = ReturnType<typeof notEditable>;

export const text = (value: string, mono = false): DetailsEditableValue => ({
  kind: "text",
  mono,
  text: value,
});

export const person = (name: string): DetailsEditableValue => ({
  choices: FIXTURE_PEOPLE,
  kind: "person",
  name,
});

export const custom = (render: () => ReactNode): DetailsReadOnlyValue => ({
  kind: "custom",
  render,
});

export const row = (
  id: DetailsFieldId,
  label: string,
  value: DetailsEditableValue,
  edit: DetailsFieldEdit,
  flag?: DetailsRowFlag
): DetailsField<DetailsFieldId> => ({ edit, flag, id, label, value });

/** A row whose value kind can never be edited. */
export const readRow = (
  id: DetailsFieldId,
  label: string,
  value: DetailsReadOnlyValue,
  edit: ReadOnlyEdit
): DetailsField<DetailsFieldId> => ({ edit, id, label, value });

/** Production writes priority on all three types (ISS-10332 for two). */
export const priorityRow = (
  surface: ArtifactPrioritySurface,
  priority: Priority | null
) =>
  row(
    DetailsFieldId.Priority,
    PRIORITY_COLUMN_LABEL,
    { kind: "priority", priority, support: ARTIFACT_PRIORITY_SUPPORT[surface] },
    editable()
  );

/**
 * Tags are editable on all three types. Branch and Issue tags are written in
 * production; Session tags are editable in the new Details (Nerys,
 * 2026-10-02), through `/entity-tags`, and ISS-10995 delivers that write.
 */
export const tagsRow = (tags: readonly string[], flag?: DetailsRowFlag) =>
  row(DetailsFieldId.Tags, "Tags", { kind: "tags", tags }, editable(), flag);

export const copyRow = (id: DetailsFieldId, label: string, value: string) =>
  readRow(
    id,
    label,
    custom(() =>
      createElement(CopyCell, {
        ariaLabel: `Copy ${label.toLowerCase()}`,
        text: value,
      })
    ),
    SYSTEM_ID
  );

export const dateTimeRow = (
  id: DetailsFieldId,
  label: string,
  iso: string,
  edit: ReadOnlyEdit
) =>
  readRow(
    id,
    label,
    custom(() => createElement(DateTimeCell, { value: iso })),
    edit
  );

export const countRow = (
  id: DetailsFieldId,
  label: string,
  count: number,
  noun: CountNoun,
  edit: ReadOnlyEdit
) =>
  readRow(
    id,
    label,
    custom(() => createElement(DetailsCountCell, { count, noun })),
    edit
  );

type DetailsLinkedRecord = ArtifactLinkedRecord & { href: string | null };

const ARTIFACT_TYPE_BY_PREFIX: Readonly<
  Record<string, Pick<ArtifactLinkedRecord, "icon" | "type">>
> = {
  ISS: { icon: ArtifactTypeIcons.Issue, type: "Issue" },
  PLN: { icon: ArtifactTypeIcons.Document, type: "Plan" },
  PRD: { icon: ArtifactTypeIcons.Document, type: "PRD" },
};
const SLUG_PREFIX = /^[A-Z]+/;

const artifactRecords = (
  host: DetailsDesignHost,
  slugs: readonly string[],
  relationship: string
): readonly DetailsLinkedRecord[] =>
  slugs.map((slug) => ({
    ...(ARTIFACT_TYPE_BY_PREFIX[slug.match(SLUG_PREFIX)?.[0] ?? ""] ?? {
      icon: ArtifactTypeIcons.Document,
      type: "Document",
    }),
    href: host.artifact(slug),
    name: "",
    relationship,
    slug,
  }));

const prRecords = (
  host: DetailsDesignHost,
  numbers: readonly number[],
  relationship: string
): readonly DetailsLinkedRecord[] =>
  numbers.map((num) => ({
    href: host.pullRequest(num, FIXTURE_REPOSITORY),
    icon: GitPullRequestIcon,
    name: "",
    relationship,
    slug: `#${num}`,
    type: "Pull request",
  }));

export const pillsRow = (
  id: DetailsFieldId,
  label: string,
  items: readonly { href: string | null; label: string }[],
  visible?: number
) =>
  readRow(
    id,
    label,
    custom(() => createElement(PillsCell, { items, visible })),
    FROM_GIT
  );

const asPills = (records: readonly DetailsLinkedRecord[]) =>
  records.map(({ href, slug }) => ({ href, label: slug }));

const fixtureTitled = (records: readonly DetailsLinkedRecord[]) =>
  records.map((record) => ({
    ...record,
    name: `Fixture: ${record.type.toLowerCase()} title`,
  }));

/** The fixture records under the production heading for their type. */
const linkedGroup = (
  type: ArtifactType,
  records: readonly DetailsLinkedRecord[]
): LinkedArtifactTableGroup => ({
  heading: LINKED_ARTIFACT_GROUP_HEADINGS[type],
  key: type,
  rows: records.map(({ href, icon, name, relationship, slug }) => ({
    href,
    icon,
    key: `${slug}:${relationship}`,
    name,
    relationship,
    slug,
  })),
});

/** Session and Issue edit custom field values in production; Branch has none. */
export const customFields = (): readonly DetailsField[] => [
  {
    edit: editable(),
    id: "cf-customer",
    label: "Fixture: Customer",
    value: text("Fixture: Northwind"),
  },
  {
    edit: editable(),
    id: "cf-risk",
    label: "Fixture: Risk",
    value: text(""),
  },
];

/**
 * Session collaborators as ISS-10992 will supply them through the host:
 * people plus the producer's evidence state. One fixture per state.
 */
export const SESSION_COLLABORATOR_FIXTURES: Readonly<
  Record<
    BranchIdentityAvailability,
    Extract<DetailsFieldValue, { kind: "people" }>
  >
> = {
  complete: {
    availability: BranchIdentityAvailability.Complete,
    kind: "people",
    people: [
      { key: "Alex Rivera", name: "Alex Rivera" },
      { key: "Jordan Kim", name: "Jordan Kim" },
    ],
  },
  incomplete: {
    availability: BranchIdentityAvailability.Incomplete,
    kind: "people",
    people: [{ key: "Alex Rivera", name: "Alex Rivera" }],
  },
  unavailable: {
    availability: BranchIdentityAvailability.Unavailable,
    kind: "people",
    people: [],
  },
};

/** ISS-12197's Session field set, in its order; see the order test. */
export function sessionDetailsConfig(
  host: DetailsDesignHost,
  collaborators = SESSION_COLLABORATOR_FIXTURES.incomplete
): DetailsConfig {
  const F = DetailsFieldId;
  return {
    core: [
      row(
        F.Name,
        "Name",
        text("Fixture: Rebuild Storybook after component tests stalled"),
        FROM_RUN
      ),
      copyRow(F.Slug, "Slug", "SES-0001"),
      // The artifact's assignee, not the session's user (decision 2026-10-07).
      row(F.Owner, "Owner", person("Alex Rivera"), NOT_YET_WRITABLE),
      readRow(F.Collaborators, "Collaborators", collaborators, DERIVED_PEOPLE),
      row(
        F.Status,
        "Status",
        {
          kind: "status",
          reason: ArtifactStatusReadOnlyReason.MachineWritten,
          view: artifactStatusView(
            "SES-0001",
            ArtifactStatusVocabulary.Session,
            "active"
          ),
        },
        FROM_RUN
      ),
      priorityRow(ArtifactPrioritySurface.Session, "MEDIUM"),
      // Unset, and read-only: the empty-row rule leaves it out.
      row(
        F.DueDate,
        "Due date",
        { date: null, kind: "date" },
        NOT_YET_WRITABLE
      ),
      dateTimeRow(
        F.CreatedAt,
        "Created at",
        "2026-09-25T09:10:00.000Z",
        SYSTEM_ID
      ),
      row(F.CreatedBy, "Created by", person("Jordan Kim"), SYSTEM_ID),
      dateTimeRow(
        F.Updated,
        "Updated at",
        "2026-09-25T09:58:41.000Z",
        SYSTEM_ID
      ),
      row(F.Project, "Project", text("Fixture: project"), FROM_RUN),
      // The Sessions grid's Tags column ships behind its flag.
      tagsRow(["Design system"], DetailsRowFlag.SessionsTags),
      copyRow(F.SessionId, "Session ID", FIXTURE_SESSION_ID),
      row(F.Autonomy, "Autonomy", text("Fixture: 82%"), FROM_HARNESS),
      row(F.Harness, "Harness", text("Claude Code"), FROM_HARNESS),
      row(F.Model, "Model", text("fixture-model", true), FROM_HARNESS),
      row(F.Repository, "Repository", text(FIXTURE_REPOSITORY, true), FROM_GIT),
      row(
        F.OtherRepositories,
        "Other repositories",
        text("fixture-org/fixture-docs", true),
        FROM_GIT
      ),
      dateTimeRow(
        F.Started,
        "Started at",
        "2026-09-25T09:12:04.000Z",
        FROM_HARNESS
      ),
      dateTimeRow(
        F.LastActive,
        "Last active at",
        "2026-09-25T09:58:41.000Z",
        FROM_RUN
      ),
      readRow(
        F.Duration,
        "Duration",
        custom(() =>
          createElement(DurationCell, {
            evidence: "Fixture: first to last event, 09:12:04 → 09:58:41",
            text: "46m 37s",
          })
        ),
        FROM_HARNESS
      ),
      // One counter per row (PLN-2169 M2 builds the production value).
      row(F.InputTokens, "Input tokens", text("12,400"), FROM_HARNESS),
      row(F.OutputTokens, "Output tokens", text("3,180"), FROM_HARNESS),
      row(F.CacheReadTokens, "Cache read tokens", text("41,000"), FROM_HARNESS),
      row(
        F.CacheWriteTokens,
        "Cache write tokens",
        text("2,750"),
        FROM_HARNESS
      ),
      readRow(F.Cost, "Estimated cost", custom(host.sessionCost), FROM_HARNESS),
      pillsRow(F.Branch, "Branches", [
        {
          href: host.branch(FIXTURE_BRANCH_ID),
          label: "fixture/rebuild-storybook",
        },
      ]),
      pillsRow(
        F.PullRequests,
        "Pull requests",
        asPills(prRecords(host, [101, 102], ""))
      ),
      countRow(
        F.SubagentCount,
        "Number of subagents",
        2,
        { one: "subagent", other: "subagents" },
        FROM_HARNESS
      ),
      countRow(
        F.ToolUseCount,
        "Number of tool calls",
        148,
        { one: "tool call", other: "tool calls" },
        FROM_HARNESS
      ),
      countRow(
        F.ErrorCount,
        "Number of errors",
        0,
        { one: "error", other: "errors" },
        FROM_HARNESS
      ),
    ],
    customFields: customFields(),
    // The Linked artifacts section is separate from the core rows (decision
    // 1, 2026-10-07); production draws a Session's links as a pill row.
    linkRows: [
      pillsRow(
        F.LinkedArtifacts,
        "Linked artifacts",
        asPills(
          artifactRecords(
            host,
            ["ISS-0001", "ISS-0002", "PRD-0001", "PLN-0001", "ISS-0003"],
            ""
          )
        ),
        3
      ),
    ],
    linked: [],
    viewerReasons: FIXTURE_VIEWER_REASONS,
    readOnlyName: fixtureReadOnlyName,
    saveErrorLabel: SAVE_ERROR_LABEL,
  };
}

/** ISS-12197's Branch field set, in its order; see the order test. */
export function branchDetailsConfig(host: DetailsDesignHost): DetailsConfig {
  const F = DetailsFieldId;
  const loc =
    LOC_METRIC_DEFINITION[LocMetricDefinitionId.BranchDetailPublicationLoc];
  return {
    core: [
      row(
        F.Name,
        "Name",
        text("fixture/graduate-row-range-drag", true),
        FROM_GIT
      ),
      // Branch artifacts carry no slug today: read-only and blank, so the
      // empty-row rule leaves it out.
      row(F.Slug, "Slug", text(""), SYSTEM_ID),
      // The artifact's assignee, not the push actor (decision 2026-10-07).
      row(F.Owner, "Owner", person("Sam Lee"), NOT_YET_WRITABLE),
      readRow(
        F.Collaborators,
        "Collaborators",
        {
          availability: BranchIdentityAvailability.Incomplete,
          kind: "people",
          people: [
            { key: "Sam Lee", name: "Sam Lee" },
            { key: "Alex Rivera", name: "Alex Rivera" },
            { key: "Jordan Kim", name: "Jordan Kim" },
          ],
        },
        DERIVED_PEOPLE
      ),
      row(
        F.Status,
        "Status",
        {
          kind: "status",
          reason: ArtifactStatusReadOnlyReason.ProviderDerived,
          view: artifactStatusView(
            "BR-0001",
            ArtifactStatusVocabulary.Branch,
            "review"
          ),
        },
        notEditable(FIXTURE_REASONS.fromPullRequest)
      ),
      priorityRow(ArtifactPrioritySurface.Branch, "HIGH"),
      row(
        F.DueDate,
        "Due date",
        { date: "2026-10-15", kind: "date" },
        NOT_YET_WRITABLE
      ),
      dateTimeRow(
        F.CreatedAt,
        "Created at",
        "2026-09-20T14:02:00.000Z",
        SYSTEM_ID
      ),
      row(F.CreatedBy, "Created by", person("Alex Rivera"), SYSTEM_ID),
      dateTimeRow(
        F.Updated,
        "Updated at",
        "2026-09-27T08:30:00.000Z",
        SYSTEM_ID
      ),
      row(F.Project, "Project", text("Fixture: project"), FROM_RUN),
      readRow(
        F.Parent,
        "Parent",
        custom(() =>
          createElement(LinkPillCell, {
            item: { href: host.artifact("ISS-0004"), label: "ISS-0004" },
          })
        ),
        SYSTEM_ID
      ),
      // No tags yet: the empty, editable affordance.
      tagsRow([]),
      row(F.Repository, "Repository", text(FIXTURE_REPOSITORY, true), FROM_GIT),
      // Text placeholder until a composite cell exists (PLN-2169 M4).
      row(
        F.PullRequests,
        "Pull Request",
        text("#201 Fixture: pull request title · open"),
        FROM_GIT
      ),
      // The Branches grid's checks rollup (`branches-table.tsx`, "N/N passing").
      row(F.ChecksStatus, "Checks status", text("8/9 passing"), FROM_GIT),
      readRow(
        F.Changes,
        "Changes",
        { additions: 1284, deletions: 377, kind: "changes" },
        FROM_GIT
      ),
      countRow(
        F.CommitCount,
        "Commit count",
        12,
        { one: "commit", other: "commits" },
        FROM_GIT
      ),
      row(F.Cost, "Estimated cost", text("$12.40"), FROM_SESSIONS),
      {
        ...row(F.LocPerDollar, "LOC / $", text("120", true), FROM_SESSIONS),
        flaggedLabel: {
          flag: DetailsRowFlag.OneLabelPerMetric,
          label: loc.canonicalLabel,
        },
      },
      countRow(
        F.LinkedSessions,
        "Sessions",
        7,
        { one: "session", other: "sessions" },
        FROM_SESSIONS
      ),
    ],
    customFields: [],
    linkRows: [],
    // The branch's resolved links: its documents and every linked session;
    // its pull request is the Pull Request field, never a row (Kerensa Whitlock
    // 2026-10-09, PLN-2175 M3).
    linked: [
      linkedGroup(
        ArtifactType.Document,
        fixtureTitled(
          artifactRecords(
            host,
            ["ISS-0004", "PRD-0002"],
            LINKED_ARTIFACT_RELATIONSHIP_LABELS[LinkType.Produces][
              LinkEnd.Target
            ]
          )
        )
      ),
      linkedGroup(
        ArtifactType.Session,
        fixtureTitled([
          {
            href: null,
            icon: ArtifactTypeIcons.Session,
            name: "",
            relationship:
              LINKED_ARTIFACT_RELATIONSHIP_LABELS[LinkType.RelatesTo][
                LinkEnd.Target
              ],
            slug: "SES-0001",
            type: "Session",
          },
        ])
      ),
    ],
    viewerReasons: FIXTURE_VIEWER_REASONS,
    readOnlyName: fixtureReadOnlyName,
    saveErrorLabel: SAVE_ERROR_LABEL,
  };
}

/**
 * Reuse check: an Issue fills the same blocks only with fields the Issue page
 * has today (title, metadata bar, project, the artifacts grid's due date, and
 * its Plan / Context / Build sections), each editable where production
 * already writes it. Not a proposal for the Issue page itself.
 */
export function issueDetailsConfig(host: DetailsDesignHost): DetailsConfig {
  const F = DetailsFieldId;
  return {
    core: [
      row(F.Name, "Name", text("Fixture: Details tab"), editable()),
      row(
        F.Status,
        "Status",
        {
          allowedTargets: ISSUE_STATUS_OPTIONS,
          kind: "status",
          view: artifactStatusView(
            "ISS-0005",
            ArtifactStatusVocabulary.Issue,
            "IN_PROGRESS"
          ),
        },
        editable()
      ),
      priorityRow(ArtifactPrioritySurface.Artifact, "HIGH"),
      row(F.Assignee, "Assignee", person("Taylor Morgan"), editable()),
      // Written in production ("Move to project" on the issue header).
      row(F.Project, "Project", text("Fixture: project"), editable()),
      copyRow(F.IssueId, "Issue ID", "ISS-0005"),
      row(F.DueDate, "Due date", { date: null, kind: "date" }, editable()),
      tagsRow(["Design system", "Research"]),
    ],
    customFields: customFields(),
    linkRows: [],
    linked: [
      linkedGroup(ArtifactType.Document, [
        ...artifactRecords(host, ["PLN-0002"], "Plan"),
        ...artifactRecords(host, ["PRD-0003"], "Context"),
      ]),
      linkedGroup(ArtifactType.Branch, [
        {
          href: host.branch(FIXTURE_BRANCH_ID),
          icon: ArtifactTypeIcons.Branch,
          name: "fixture/details-design",
          relationship: "Branches",
          slug: "BR-0001",
          type: "Branch",
        },
      ]),
    ],
    viewerReasons: FIXTURE_VIEWER_REASONS,
    readOnlyName: fixtureReadOnlyName,
    saveErrorLabel: SAVE_ERROR_LABEL,
  };
}
