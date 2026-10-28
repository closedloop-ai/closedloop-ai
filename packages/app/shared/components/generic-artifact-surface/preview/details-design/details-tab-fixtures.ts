// gardener-support: test and story data, not shipped
import {
  ArtifactStatusReadOnlyReason,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import type { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_STATUS_OPTIONS,
  ISSUE_STATUS_OPTIONS,
} from "@repo/api/src/types/document";
import { ArtifactPrioritySurface } from "@repo/app/shared/lib/artifact-priority-ownership";
import { artifactStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { createElement } from "react";
import { ArtifactTypeIcons } from "../components/artifact-icons";
import { DurationCell, PillsCell } from "./details-design-cells";
import {
  branchDetailsConfig,
  copyRow,
  countRow,
  custom,
  customFields,
  DERIVED_PEOPLE,
  dateTimeRow,
  editable,
  FIXTURE_BRANCH_ID,
  FIXTURE_REASONS,
  FIXTURE_REPOSITORY,
  FIXTURE_SESSION_ID,
  FIXTURE_VIEWER_REASONS,
  FROM_GIT,
  FROM_HARNESS,
  FROM_RUN,
  FROM_SESSIONS,
  fixtureReadOnlyName,
  NOT_YET_WRITABLE,
  notEditable,
  person,
  priorityRow,
  readRow,
  row,
  SAVE_ERROR_LABEL,
  SYSTEM_ID,
  sessionDetailsConfig,
  tagsRow,
  text,
} from "./details-design-fixtures";
import {
  type DetailsDesignHost,
  type DetailsField,
  isSelfSavingField,
} from "./details-design-model";
import type { DetailsPullRequest } from "./details-tab-cells";
import {
  associatedTableGroups,
  type DetailsAssociatedRecord,
  DetailsLinkEnd,
  DetailsLinkType,
  DetailsTabArtifactType,
  type DetailsTabConfig,
  DetailsTabFieldId,
  detailsRelationship,
} from "./details-tab-model";
import {
  BRANCH_DETAILS_TAB_MORE,
  type BranchDetailsTabMore,
  branchMoreRows,
  codexRows,
  FIXTURE_BRANCH_PULL_REQUEST,
  formatCount,
  launchRows,
  pullRequestRow,
  rowsWhen,
  type SessionCodexRuntimeDetails,
  type SessionLaunchDetails,
  sessionsRow,
  typeRow,
  withId,
} from "./details-tab-more-rows";

/**
 * ISS-12252 fixtures for the Details tab design. The rows are the shipped
 * Details model's (`details-design-fixtures.ts`, ISS-12197's fields in its
 * order); what the design adds is the Associated artifacts list with a relationship per link, a
 * Parent row that can name several parents, and a Document. A Session or
 * Branch config takes the page's own values, so a Surfaces story's Details
 * tab describes the same artifact as its header. Every id is fake.
 */

const F = DetailsTabFieldId;

const PROJECT = "Fixture: Artifact detail pages";

const LINK_KIND_BY_PREFIX: Readonly<
  Record<string, Pick<DetailsAssociatedRecord, "icon" | "type">>
> = {
  BR: { icon: ArtifactTypeIcons.Branch, type: "Branch" },
  // Production draws a pull request with the branch icon, beside its branch.
  PR: { icon: ArtifactTypeIcons.Branch, type: "Pull request" },
  ISS: { icon: ArtifactTypeIcons.Issue, type: "Issue" },
  // The legacy slug for an issue.
  FEA: { icon: ArtifactTypeIcons.Issue, type: "Issue" },
  SES: { icon: ArtifactTypeIcons.Session, type: "Session" },
};

/** Any other prefix (PRD, PLN, DOC, TPL, ...) is a document. */
const DOCUMENT_LINK_KIND: Pick<DetailsAssociatedRecord, "icon" | "type"> = {
  icon: ArtifactTypeIcons.Document,
  type: "Document",
};

/**
 * One link as the Associated list draws it: the linked artifact, and the
 * link's type and which end this artifact is on. A page's own fixture passes
 * `href: null` for an inert row.
 */
export function detailsAssociatedRecord({
  end,
  href,
  linkType,
  name,
  slug,
  type,
}: {
  end: DetailsLinkEnd;
  href: string | null;
  linkType: DetailsLinkType;
  name: string;
  slug: string;
  /** The kind, when the slug's prefix does not say it (a branch name). */
  type?: "BR" | "PR" | "ISS" | "SES";
}): DetailsAssociatedRecord {
  const prefix = type ?? slug.split("-")[0] ?? "";
  const kind = LINK_KIND_BY_PREFIX[prefix] ?? DOCUMENT_LINK_KIND;
  return {
    ...kind,
    href,
    name,
    relationship: detailsRelationship(linkType, end),
    slug,
  };
}

/** A fixture link, with the harness host's href. */
function link(
  host: DetailsDesignHost,
  slug: string,
  name: string,
  linkType: DetailsLinkType,
  end: DetailsLinkEnd
): DetailsAssociatedRecord {
  return detailsAssociatedRecord({
    end,
    href: slug.startsWith("BR-")
      ? host.branch(FIXTURE_BRANCH_ID)
      : host.artifact(slug),
    linkType,
    name,
    slug,
  });
}

const { Produces, Blocks, RelatesTo } = DetailsLinkType;
const { Source, Target } = DetailsLinkEnd;

/**
 * The Parent row: every artifact this one is produced by, as pills. Read-only
 * here, as the Associated list is; the list says what each link is.
 */
function parentRow(
  records: readonly DetailsAssociatedRecord[]
): DetailsField<string> {
  const parents = records.filter((record) => record.relationship === "parent");
  return readRow(
    F.Parent,
    parents.length > 1 ? "Parents" : "Parent",
    custom(() =>
      createElement(PillsCell, {
        items: parents.map(({ href, slug }) => ({ href, label: slug })),
      })
    ),
    SYSTEM_ID
  );
}

/** Puts the Parent row right after Project, replacing any it had. */
function withParentRow(
  core: readonly DetailsField[],
  records: readonly DetailsAssociatedRecord[]
): DetailsField[] {
  const rows = core.filter((field) => field.id !== F.Parent);
  const at = rows.findIndex((field) => field.id === F.Project) + 1;
  if (!records.some((record) => record.relationship === "parent")) {
    return rows;
  }
  return [...rows.slice(0, at), parentRow(records), ...rows.slice(at)];
}

/**
 * The fields a person sets on any artifact. v2.0 locks several of them
 * until ISS-10995's writes land; the Details tab shows them editable, as the meeting
 * asked (everything a person owns is assumed editable). System and derived
 * values (ids, times, git facts, usage) stay read-only.
 */
const EDITABLE_ON_DETAILS_TAB: readonly string[] = [
  F.Name,
  F.Owner,
  F.DueDate,
  F.Project,
];

function editableOnDetailsTab(core: readonly DetailsField[]): DetailsField[] {
  return core.map((field) =>
    EDITABLE_ON_DETAILS_TAB.includes(field.id) &&
    field.value.kind !== "custom" &&
    field.value.kind !== "people" &&
    field.value.kind !== "changes"
      ? ({ ...field, edit: editable() } as DetailsField)
      : field
  );
}

/** The page values a Session's Details read. */
export type SessionDetailsTabInput = {
  name: string;
  slug: string;
  sessionId: string;
  /** The status the page header shows. */
  status: string;
  owner: string;
  /** Absent: the shipped Details fixture list, partly read. */
  collaborators?: readonly string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  autonomy: string;
  harness: string;
  model: string;
  repository: string;
  otherRepositories: readonly string[];
  startedAt: string;
  lastActiveAt: string;
  duration: { evidence: string; text: string };
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Absent: production's own Cost cell, through the host. */
  cost?: string;
  /** Absent: the fixture project. Null: in no project, so no custom fields. */
  project?: string | null;
  /** Absent: Medium. */
  priority?: Priority | null;
  /** Absent: the fixture tag. */
  tags?: readonly string[];
  /** Absent: the fixture links, with two parents. */
  associated?: readonly DetailsAssociatedRecord[];
  branches: readonly { id: string; label: string }[];
  pullRequests: readonly number[];
  subagents: number;
  toolUses: number;
  errors: number;
  // Kerensa's reconciliation (2026-10-07): rows the Properties panel shows today.
  // Each is absent when the session reports nothing, and its row is left out.
  /** The Sync row's words ("Synced · Full transcripts"). */
  sync?: string;
  /** Launch attribution, behind production's flag. */
  launch?: SessionLaunchDetails;
  linesChanged?: { additions: number; deletions: number };
  /** The cache-write split by TTL; Codex and older sessions report none. */
  cacheWriteTtl?: { fiveMinute: number; oneHour: number };
  locPerDollar?: string;
  /** Work, one counter per row: turns and steering episodes. */
  turns?: number;
  steers?: number;
  /** Codex sessions only. */
  codex?: SessionCodexRuntimeDetails;
};

/** the shipped Details fixture Session, with the reconciliation's rows. */
export const SESSION_DETAILS_TAB_FIXTURE: SessionDetailsTabInput = {
  name: "Fixture: Rebuild Storybook after component tests stalled",
  slug: "SES-0001",
  sessionId: FIXTURE_SESSION_ID,
  status: "active",
  owner: "Alex Rivera",
  createdBy: "Jordan Kim",
  createdAt: "2026-09-25T09:10:00.000Z",
  updatedAt: "2026-09-25T09:58:41.000Z",
  autonomy: "Fixture: 82%",
  harness: "Claude Code",
  model: "fixture-model",
  repository: FIXTURE_REPOSITORY,
  otherRepositories: ["fixture-org/fixture-docs"],
  startedAt: "2026-09-25T09:12:04.000Z",
  lastActiveAt: "2026-09-25T09:58:41.000Z",
  duration: {
    evidence: "Fixture: first to last event, 09:12:04 → 09:58:41",
    text: "46m 37s",
  },
  inputTokens: 12_400,
  outputTokens: 3180,
  cacheReadTokens: 41_000,
  cacheWriteTokens: 2750,
  branches: [{ id: FIXTURE_BRANCH_ID, label: "fixture/rebuild-storybook" }],
  pullRequests: [101, 102],
  subagents: 2,
  toolUses: 148,
  errors: 0,
  sync: "Synced · Full transcripts",
  launch: {
    thread: "User-started",
    agentRole: "fixture-builder",
    firstSkill: "storybook-curate",
    promptSource: "Typed by a person",
  },
  linesChanged: { additions: 420, deletions: 96 },
  cacheWriteTtl: { fiveMinute: 2000, oneHour: 750 },
  locPerDollar: "143",
  turns: 31,
  steers: 3,
};

/** A Codex session: no cache-write split, and its runtime rows. */
export const SESSION_DETAILS_TAB_CODEX_FIXTURE: SessionDetailsTabInput = {
  ...SESSION_DETAILS_TAB_FIXTURE,
  harness: "Codex",
  launch: undefined,
  cacheWriteTtl: undefined,
  codex: {
    contextWindow: "272,000 tokens | 38% used (latest turn)",
    latestTurnTokens:
      "96,210 in | 1,840 out | 88,000 cache read | 0 cache write",
    rateLimits: [
      { label: "Rate limit (5h)", value: "22% used | resets in 3h 10m" },
      { label: "Rate limit (weekly)", value: "41% used | resets in 4d 6h" },
    ],
  },
};

/** A people list read in full, from names. */
const peopleRow = (names: readonly string[]) =>
  readRow(
    F.Collaborators,
    "Collaborators",
    { kind: "people", people: names.map((name) => ({ key: name, name })) },
    DERIVED_PEOPLE
  );

/**
 * A Session's links: two parents, as a session can serve several artifacts,
 * and the branch and pull requests it produced.
 */
function sessionAssociated(host: DetailsDesignHost) {
  return [
    link(
      host,
      "ISS-0001",
      "Fixture: Details tab for sessions",
      Produces,
      Target
    ),
    link(host, "PRD-0001", "Fixture: Artifact detail pages", Produces, Target),
    link(host, "BR-0001", "fixture/rebuild-storybook", Produces, Source),
    // ISS-12403: its pull requests are listed here, not as a Details row.
    ...SESSION_DETAILS_TAB_FIXTURE.pullRequests.map((num) =>
      detailsAssociatedRecord({
        end: Source,
        href: host.pullRequest(num, FIXTURE_REPOSITORY),
        linkType: Produces,
        name: `Fixture: pull request #${num}`,
        slug: `#${num}`,
        type: "PR",
      })
    ),
    link(host, "ISS-0003", "Fixture: Storybook build cache", Blocks, Source),
    link(host, "PLN-0001", "Fixture: Details tab plan", RelatesTo, Source),
    link(host, "ISS-0002", "Fixture: Component tests stall", RelatesTo, Target),
  ];
}

/** ISS-12197's Session fields, in its order, from `input`. */
export function sessionDetailsTabConfig(
  host: DetailsDesignHost,
  input: SessionDetailsTabInput = SESSION_DETAILS_TAB_FIXTURE
): DetailsTabConfig {
  const v20 = sessionDetailsConfig(host);
  const associated = input.associated ?? sessionAssociated(host);
  const project = input.project === undefined ? PROJECT : input.project;
  const core: DetailsField[] = [
    row(F.Name, "Name", text(input.name), FROM_RUN),
    copyRow(F.Slug, "Slug", input.slug),
    row(F.Owner, "Owner", person(input.owner), NOT_YET_WRITABLE),
    ...(input.collaborators
      ? [peopleRow(input.collaborators)]
      : v20.core.filter((field) => field.id === F.Collaborators)),
    row(
      F.Status,
      "Status",
      {
        kind: "status",
        reason: ArtifactStatusReadOnlyReason.MachineWritten,
        view: artifactStatusView(
          input.slug,
          ArtifactStatusVocabulary.Session,
          input.status
        ),
      },
      FROM_RUN
    ),
    priorityRow(
      ArtifactPrioritySurface.Session,
      input.priority === undefined ? "MEDIUM" : input.priority
    ),
    row(F.DueDate, "Due date", { date: null, kind: "date" }, NOT_YET_WRITABLE),
    dateTimeRow(F.CreatedAt, "Created at", input.createdAt, SYSTEM_ID),
    row(F.CreatedBy, "Created by", person(input.createdBy), SYSTEM_ID),
    dateTimeRow(F.Updated, "Updated at", input.updatedAt, SYSTEM_ID),
    row(F.Project, "Project", text(project ?? ""), FROM_RUN),
    tagsRow(input.tags ?? ["Design system"]),
    copyRow(F.SessionId, "Session ID", input.sessionId),
    row(F.Autonomy, "Autonomy", text(input.autonomy), FROM_HARNESS),
    row(F.Harness, "Harness", text(input.harness), FROM_HARNESS),
    row(F.Model, "Model", text(input.model, true), FROM_HARNESS),
    ...rowsWhen(input.launch, launchRows),
    ...rowsWhen(input.sync, (sync) => [
      typeRow(F.Sync, "Sync", text(sync), FROM_RUN),
    ]),
    row(F.Repository, "Repository", text(input.repository, true), FROM_GIT),
    row(
      F.OtherRepositories,
      "Other repositories",
      text(input.otherRepositories.join(", "), true),
      FROM_GIT
    ),
    dateTimeRow(F.Started, "Started at", input.startedAt, FROM_HARNESS),
    dateTimeRow(F.LastActive, "Last active at", input.lastActiveAt, FROM_RUN),
    readRow(
      F.Duration,
      "Duration",
      custom(() => createElement(DurationCell, input.duration)),
      FROM_HARNESS
    ),
    row(
      F.InputTokens,
      "Input tokens",
      text(formatCount(input.inputTokens)),
      FROM_HARNESS
    ),
    row(
      F.OutputTokens,
      "Output tokens",
      text(formatCount(input.outputTokens)),
      FROM_HARNESS
    ),
    row(
      F.CacheReadTokens,
      "Cache read tokens",
      text(formatCount(input.cacheReadTokens)),
      FROM_HARNESS
    ),
    row(
      F.CacheWriteTokens,
      "Cache write tokens",
      text(formatCount(input.cacheWriteTokens)),
      FROM_HARNESS
    ),
    ...rowsWhen(input.cacheWriteTtl, (ttl) => [
      typeRow(
        F.CacheWriteTtl,
        "Cache write TTL",
        text(
          `${formatCount(ttl.fiveMinute)} (5m) | ${formatCount(ttl.oneHour)} (1h)`,
          true
        ),
        FROM_HARNESS
      ),
    ]),
    input.cost === undefined
      ? readRow(
          F.Cost,
          "Estimated cost",
          custom(host.sessionCost),
          FROM_HARNESS
        )
      : row(F.Cost, "Estimated cost", text(input.cost), FROM_HARNESS),
    ...rowsWhen(input.locPerDollar, (loc) => [
      row(F.LocPerDollar, "LOC / $", text(loc, true), FROM_HARNESS),
    ]),
    readRow(
      F.Branch,
      "Branches",
      {
        // Empty, so the empty-row rule leaves the read-only row out.
        empty: input.branches.length === 0,
        kind: "custom",
        render: () =>
          createElement(PillsCell, {
            items: input.branches.map((branch) => ({
              href: host.branch(branch.id),
              label: branch.label,
            })),
          }),
      },
      FROM_GIT
    ),
    readRow(
      F.PullRequests,
      "Pull requests",
      {
        empty: input.pullRequests.length === 0,
        kind: "custom",
        render: () =>
          createElement(PillsCell, {
            items: input.pullRequests.map((num) => ({
              href: host.pullRequest(num, input.repository),
              label: `#${num}`,
            })),
          }),
      },
      FROM_GIT
    ),
    ...rowsWhen(input.linesChanged, (lines) => [
      withId(
        F.LinesChanged,
        readRow(
          F.Changes,
          "Lines changed",
          { ...lines, kind: "changes" },
          FROM_GIT
        )
      ),
    ]),
    ...rowsWhen(input.turns, (turns) => [
      withId(
        F.TurnCount,
        countRow(
          F.ToolUseCount,
          "Number of turns",
          turns,
          { one: "turn", other: "turns" },
          FROM_HARNESS
        )
      ),
    ]),
    countRow(
      F.SubagentCount,
      "Number of subagents",
      input.subagents,
      { one: "subagent", other: "subagents" },
      FROM_HARNESS
    ),
    countRow(
      F.ToolUseCount,
      "Number of tool calls",
      input.toolUses,
      { one: "tool call", other: "tool calls" },
      FROM_HARNESS
    ),
    ...rowsWhen(input.steers, (steers) => [
      withId(
        F.SteerCount,
        countRow(
          F.ToolUseCount,
          "Number of steers",
          steers,
          { one: "steer", other: "steers" },
          FROM_HARNESS
        )
      ),
    ]),
    countRow(
      F.ErrorCount,
      "Number of errors",
      input.errors,
      { one: "error", other: "errors" },
      FROM_HARNESS
    ),
    ...rowsWhen(input.codex, codexRows),
  ];
  return {
    type: DetailsTabArtifactType.Session,
    base: {
      ...v20,
      core: editableOnDetailsTab(withParentRow(core, associated)),
      // Custom fields belong to a project; a session in none has none.
      customFields: project ? v20.customFields : [],
      linkRows: [],
      linked: associatedTableGroups(associated),
    },
    customFieldsProject: project,
  };
}

/** The page values a Branch's Details read. */
export type BranchDetailsTabInput = {
  name: string;
  status: string;
  owner: string;
  collaborators: readonly string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  project: string | null;
  priority: Priority | null;
  dueDate: string | null;
  tags: readonly string[];
  associated: readonly DetailsAssociatedRecord[];
  repository: string;
  pullRequest: DetailsPullRequest;
  checks: string;
  changes: { additions: number; deletions: number };
  /** Absent: the page has no count, so the row is left out. */
  commits?: number;
  cost: string;
  locPerDollar: string;
  sessions: number;
  /**
   * Kerensa's reconciliation (2026-10-07): candidates already on the branch-detail
   * payload. Each is absent when the page has no value, and its row is left
   * out.
   */
  more?: BranchDetailsTabMore;
};

/** A Branch's links: produced by an issue and by the session that pushed it. */
function branchAssociated(host: DetailsDesignHost) {
  return [
    link(
      host,
      "ISS-0004",
      "Fixture: Graduate row range drag",
      Produces,
      Target
    ),
    link(host, "SES-0001", "Fixture: Rebuild Storybook", Produces, Target),
    link(host, "ISS-0006", "Fixture: Grid selection model", Blocks, Target),
    link(host, "PRD-0002", "Fixture: Table interactions", RelatesTo, Source),
  ];
}

/** ISS-12197's Branch fields, in its order: the shipped Details rows with `input`'s values. */
export function branchDetailsTabConfig(
  host: DetailsDesignHost,
  input?: BranchDetailsTabInput
): DetailsTabConfig {
  const v20 = branchDetailsConfig(host);
  const associated = input?.associated ?? branchAssociated(host);
  const values: Partial<Record<string, DetailsField>> = input
    ? {
        [F.Name]: row(F.Name, "Name", text(input.name, true), FROM_GIT),
        [F.Project]: row(
          F.Project,
          "Project",
          text(input.project ?? ""),
          FROM_RUN
        ),
        [F.Priority]: priorityRow(
          ArtifactPrioritySurface.Branch,
          input.priority
        ),
        [F.DueDate]: row(
          F.DueDate,
          "Due date",
          { date: input.dueDate, kind: "date" },
          NOT_YET_WRITABLE
        ),
        [F.Tags]: tagsRow(input.tags),
        [F.Owner]: row(F.Owner, "Owner", person(input.owner), NOT_YET_WRITABLE),
        [F.Collaborators]: peopleRow(input.collaborators),
        [F.CreatedAt]: dateTimeRow(
          F.CreatedAt,
          "Created at",
          input.createdAt,
          SYSTEM_ID
        ),
        [F.CreatedBy]: row(
          F.CreatedBy,
          "Created by",
          person(input.createdBy),
          SYSTEM_ID
        ),
        [F.Updated]: dateTimeRow(
          F.Updated,
          "Updated at",
          input.updatedAt,
          SYSTEM_ID
        ),
        [F.Status]: row(
          F.Status,
          "Status",
          {
            kind: "status",
            reason: ArtifactStatusReadOnlyReason.ProviderDerived,
            view: artifactStatusView(
              "BR-0001",
              ArtifactStatusVocabulary.Branch,
              input.status
            ),
          },
          notEditable(FIXTURE_REASONS.fromPullRequest)
        ),
        [F.Repository]: row(
          F.Repository,
          "Repository",
          text(input.repository, true),
          FROM_GIT
        ),
        [F.PullRequests]: pullRequestRow(input.pullRequest),
        [F.ChecksStatus]: row(
          F.ChecksStatus,
          "Checks status",
          text(input.checks),
          FROM_GIT
        ),
        [F.Changes]: readRow(
          F.Changes,
          "Changes",
          { ...input.changes, kind: "changes" },
          FROM_GIT
        ),
        ...(input.commits === undefined
          ? {}
          : {
              [F.CommitCount]: countRow(
                F.CommitCount,
                "Commit count",
                input.commits,
                { one: "commit", other: "commits" },
                FROM_GIT
              ),
            }),
        [F.Cost]: row(
          F.Cost,
          "Estimated cost",
          text(input.cost),
          FROM_SESSIONS
        ),
        [F.LinkedSessions]: sessionsRow(
          input.sessions,
          input.more?.participation
        ),
      }
    : {
        [F.PullRequests]: pullRequestRow(FIXTURE_BRANCH_PULL_REQUEST),
        [F.LinkedSessions]: sessionsRow(
          7,
          BRANCH_DETAILS_TAB_MORE.participation
        ),
      };
  const rows = v20.core.filter(
    (field) =>
      !(input && input.commits === undefined && field.id === F.CommitCount)
  );
  const replaced = rows.map((field) => {
    const replaced = values[field.id];
    if (replaced) {
      return replaced;
    }
    if (field.id === F.LocPerDollar && input && !isSelfSavingField(field)) {
      return { ...field, value: text(input.locPerDollar, true) };
    }
    return field;
  });
  const core = [
    ...replaced,
    ...branchMoreRows(input ? (input.more ?? {}) : BRANCH_DETAILS_TAB_MORE),
  ];
  return {
    type: DetailsTabArtifactType.Branch,
    base: {
      ...v20,
      core: editableOnDetailsTab(withParentRow(core, associated)),
      linkRows: [],
      linked: associatedTableGroups(associated),
    },
    // Branches have no custom fields in production today.
    customFieldsProject: null,
  };
}

/** A PRD's links: one of each relationship, and several children. */
function documentAssociated(host: DetailsDesignHost) {
  return [
    link(host, "PRD-0004", "Fixture: Artifact platform", Produces, Target),
    link(host, "ISS-0005", "Fixture: Details tab", Produces, Source),
    link(host, "ISS-0007", "Fixture: Activity tab", Produces, Source),
    link(host, "PLN-0002", "Fixture: Details tab plan", Produces, Source),
    link(host, "ISS-0008", "Fixture: Link types in the API", Blocks, Target),
    link(host, "ISS-0009", "Fixture: Document templates", Blocks, Source),
    link(host, "PRD-0003", "Fixture: Custom fields", RelatesTo, Source),
  ];
}

/**
 * The slug and name a Details fixture shows. A page preview passes its own
 * artifact's, so the Details tab names the page it sits on.
 */
export type DetailsFixtureIdentity = Readonly<{ slug: string; title: string }>;

const DOCUMENT_IDENTITY: DetailsFixtureIdentity = {
  slug: "PRD-0001",
  title: "Fixture: Artifact detail pages",
};

const ISSUE_IDENTITY: DetailsFixtureIdentity = {
  slug: "ISS-0005",
  title: "Fixture: Issue detail page shell",
};

/**
 * A Document (a PRD). Its own group is Current version alone (PRD-799,
 * ISS-12586): no Document type and no Approver. Version history is the
 * canvas's dropdown, not a field here.
 */
export function documentDetailsTabConfig(
  host: DetailsDesignHost,
  identity: DetailsFixtureIdentity = DOCUMENT_IDENTITY
): DetailsTabConfig {
  const associated = documentAssociated(host);
  const priority: Priority = "HIGH";
  const core: DetailsField[] = [
    row(F.Name, "Name", text(identity.title), editable()),
    copyRow(F.Slug, "Slug", identity.slug),
    row(F.Owner, "Owner", person("Taylor Morgan"), editable()),
    readRow(
      F.Collaborators,
      "Collaborators",
      {
        kind: "people",
        people: [
          { key: "Taylor Morgan", name: "Taylor Morgan" },
          { key: "Sam Lee", name: "Sam Lee" },
        ],
      },
      DERIVED_PEOPLE
    ),
    row(
      F.Status,
      "Status",
      {
        allowedTargets: DOCUMENT_STATUS_OPTIONS,
        kind: "status",
        view: artifactStatusView(
          identity.slug,
          ArtifactStatusVocabulary.Document,
          "IN_REVIEW"
        ),
      },
      editable()
    ),
    priorityRow(ArtifactPrioritySurface.Artifact, priority),
    row(
      F.DueDate,
      "Due date",
      { date: "2026-10-24", kind: "date" },
      editable()
    ),
    dateTimeRow(
      F.CreatedAt,
      "Created at",
      "2026-10-01T15:20:00.000Z",
      SYSTEM_ID
    ),
    row(F.CreatedBy, "Created by", person("Taylor Morgan"), SYSTEM_ID),
    dateTimeRow(F.Updated, "Updated at", "2026-10-07T18:35:00.000Z", SYSTEM_ID),
    row(F.Project, "Project", text(PROJECT), editable()),
    tagsRow(["Design system", "Research"]),
    repositoriesRow(),
    typeRow(F.CurrentVersion, "Current version", text("v5", true), SYSTEM_ID),
  ];
  const base: DetailsTabConfig["base"] = {
    core: withParentRow(core, associated),
    customFields: customFields(),
    linkRows: [],
    linked: associatedTableGroups(associated),
    viewerReasons: FIXTURE_VIEWER_REASONS,
    readOnlyName: fixtureReadOnlyName,
    saveErrorLabel: SAVE_ERROR_LABEL,
  };
  return {
    type: DetailsTabArtifactType.Document,
    base,
    customFieldsProject: PROJECT,
  };
}

/**
 * A document's or issue's repositories (ISS-12572): the repository snapshot
 * the server sets from the project's defaults. Read-only (PRD-799 T-09).
 */
const repositoriesRow = () =>
  typeRow(
    F.Repositories,
    "Repositories",
    text(FIXTURE_REPOSITORY, true),
    notEditable("Fixture: Set from the project's repositories.")
  );

/** An Issue's links: its parent, two sub-issues, the plan and a blocker. */
function issueAssociated(host: DetailsDesignHost) {
  return [
    link(host, "ISS-0004", "Fixture: Artifact detail pages", Produces, Target),
    link(host, "ISS-0011", "Fixture: Issue card", Produces, Source),
    link(host, "ISS-0012", "Fixture: Activity brief", Produces, Source),
    link(host, "PLN-0002", "Fixture: Details tab plan", Produces, Source),
    link(host, "ISS-0008", "Fixture: Link types in the API", Blocks, Target),
  ];
}

/** A Details row of pills, under an id the Details tab adds. */
const pillsTypeRow = (
  id: DetailsTabFieldId,
  label: string,
  items: readonly { href: string | null; label: string }[]
) =>
  withId(
    id,
    readRow(
      F.Parent,
      label,
      custom(() => createElement(PillsCell, { items })),
      SYSTEM_ID
    )
  );

/**
 * An Issue (ISS-12586). The common group carries no Status or Parent row:
 * the Issue details group holds the issue's own status, why it closed and
 * where it sits in the issue tree, so neither is drawn twice. The rest is the
 * Associated list.
 */
export function issueDetailsTabConfig(
  host: DetailsDesignHost,
  identity: DetailsFixtureIdentity = ISSUE_IDENTITY
): DetailsTabConfig {
  const associated = issueAssociated(host);
  const priority: Priority = "HIGH";
  const core: DetailsField[] = [
    row(F.Name, "Name", text(identity.title), editable()),
    copyRow(F.Slug, "Slug", identity.slug),
    row(F.Owner, "Owner", person("Taylor Morgan"), editable()),
    row(F.Assignee, "Assignee", person("Sam Lee"), editable()),
    readRow(
      F.Collaborators,
      "Collaborators",
      {
        kind: "people",
        people: [
          { key: "Taylor Morgan", name: "Taylor Morgan" },
          { key: "Sam Lee", name: "Sam Lee" },
        ],
      },
      DERIVED_PEOPLE
    ),
    priorityRow(ArtifactPrioritySurface.Artifact, priority),
    row(
      F.DueDate,
      "Due date",
      { date: "2026-10-24", kind: "date" },
      editable()
    ),
    dateTimeRow(
      F.CreatedAt,
      "Created at",
      "2026-10-01T15:20:00.000Z",
      SYSTEM_ID
    ),
    row(F.CreatedBy, "Created by", person("Taylor Morgan"), SYSTEM_ID),
    dateTimeRow(F.Updated, "Updated at", "2026-10-07T18:35:00.000Z", SYSTEM_ID),
    row(F.Project, "Project", text(PROJECT), editable()),
    tagsRow(["Design system", "Research"]),
    repositoriesRow(),
    typeRow(
      F.IssueStatus,
      "Issue status",
      {
        allowedTargets: ISSUE_STATUS_OPTIONS,
        kind: "status",
        view: artifactStatusView(
          identity.slug,
          ArtifactStatusVocabulary.Issue,
          "DONE"
        ),
      },
      editable()
    ),
    typeRow(F.ClosedReason, "Closed reason", text("Completed"), editable()),
    pillsTypeRow(F.ParentIssue, "Parent issue", [
      { href: host.artifact("ISS-0004"), label: "ISS-0004" },
    ]),
    pillsTypeRow(F.SubIssues, "Sub-issues", [
      { href: host.artifact("ISS-0011"), label: "ISS-0011" },
      { href: host.artifact("ISS-0012"), label: "ISS-0012" },
    ]),
    readRow(
      F.Branch,
      "Linked branch",
      custom(() =>
        createElement(PillsCell, {
          items: [
            {
              href: host.branch(FIXTURE_BRANCH_ID),
              label: "fixture/issue-detail-shell",
            },
          ],
        })
      ),
      FROM_GIT
    ),
    pillsTypeRow(F.ExternalLinks, "External links", [
      { href: "https://closedloop.invalid/external/1", label: "Fixture: spec" },
    ]),
  ];
  return {
    type: DetailsTabArtifactType.Issue,
    base: {
      core,
      customFields: customFields(),
      linkRows: [],
      linked: associatedTableGroups(associated),
      viewerReasons: FIXTURE_VIEWER_REASONS,
      readOnlyName: fixtureReadOnlyName,
      saveErrorLabel: SAVE_ERROR_LABEL,
    },
    customFieldsProject: PROJECT,
  };
}

/** Every Details tab fixture config, by type. */
export const DETAILS_TAB_FIXTURE_CONFIGS = {
  session: sessionDetailsTabConfig,
  branch: branchDetailsTabConfig,
  document: documentDetailsTabConfig,
  issue: issueDetailsTabConfig,
} as const satisfies Record<
  DetailsTabArtifactType,
  (host: DetailsDesignHost) => DetailsTabConfig
>;
