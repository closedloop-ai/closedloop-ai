import { Priority } from "@repo/api/src/types/common";
import {
  type ArtifactStatus,
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  type CatalogProject,
  type CatalogTopic,
  PROJECT_CATALOG,
  SeedRole,
  SupportingDocKind,
  TopicStage,
} from "./base-seed-catalog";

/**
 * ISS-12135 (bugs 15, 23): where every seeded project and document lands, who
 * wrote and owns it, and when. Pure, so the shape of the seeded org can be
 * checked without a database. Each topic's PRD comes first, then its plan and
 * supporting doc, then its issues; statuses follow the topic's stage.
 */

export type SeedRoster = {
  /** The signed-in person; owns a small slice so My Tasks and Me have rows. */
  readonly admin: string;
  readonly pms: readonly string[];
  readonly engineers: readonly string[];
  readonly designers: readonly string[];
};

export type PlannedProject = {
  readonly baseKey: string;
  readonly name: string;
  readonly description: string;
  readonly priority: Priority;
  readonly status: ProjectStatus;
  readonly leadId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type PlannedDocument = {
  readonly projectIndex: number;
  readonly topic: string;
  readonly subtype: PlannedSubtype;
  readonly title: string;
  readonly status: ArtifactStatus;
  /** Statuses the document passed through, oldest first, ending at `status`. */
  readonly history: readonly ArtifactStatus[];
  readonly priority: Priority;
  readonly createdById: string;
  readonly assigneeId: string;
  /** Who approves or sends it back; issues are moved by their assignee. */
  readonly reviewerId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type PlannedSubtype =
  | typeof DocumentType.Prd
  | typeof DocumentType.ImplementationPlan
  | typeof DocumentType.Doc
  | typeof DocumentType.Feature;

export type BaseSeedContentPlan = {
  readonly projects: readonly PlannedProject[];
  readonly documents: readonly PlannedDocument[];
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Nothing seeded is touched in the final half hour, so no row reads "just now". */
const LATEST_TOUCH_MS = 30 * 60 * 1000;
const PROJECT_LEAD_TIME_DAYS = 4;
/** Open work was last touched somewhere in the last four days. */
const RECENT_TOUCH_WINDOW_HOURS = 96;
/** Statuses where work is still moving; anything else stopped when it landed. */
const OPEN_STATUSES: ReadonlySet<ArtifactStatus> = new Set([
  DocumentStatus.Draft,
  DocumentStatus.InReview,
  DocumentStatus.ChangesRequested,
  IssueStatus.Triage,
  IssueStatus.Backlog,
  IssueStatus.Todo,
  IssueStatus.InProgress,
  IssueStatus.InReview,
  IssueStatus.Blocked,
]);

const PRIORITY_ORDER: readonly Priority[] = [
  Priority.Low,
  Priority.Medium,
  Priority.High,
  Priority.Urgent,
];
/** Issue priorities wander around their topic's: same, lower, same, higher. */
const ISSUE_PRIORITY_STEPS: readonly number[] = [0, -1, 0, 1];

type StageShape = {
  /** Days before now the topic's PRD was written, before the per-topic stagger. */
  readonly startDaysAgo: number;
  readonly staggerDays: number;
  readonly prd: readonly ArtifactStatus[];
  readonly plan: readonly ArtifactStatus[];
  readonly doc: readonly ArtifactStatus[];
  /** Issue statuses by position; the last entry repeats. */
  readonly issues: readonly (readonly ArtifactStatus[])[];
};

const PRD_APPROVED = [
  DocumentStatus.Draft,
  DocumentStatus.InReview,
  DocumentStatus.Approved,
];
const ISSUE_DONE = [
  IssueStatus.Todo,
  IssueStatus.InProgress,
  IssueStatus.InReview,
  IssueStatus.Done,
];

const STAGE_SHAPES: Readonly<Record<TopicStage, StageShape>> = {
  [TopicStage.Shipped]: {
    startDaysAgo: 56,
    staggerDays: 3,
    prd: PRD_APPROVED,
    plan: [...PRD_APPROVED, DocumentStatus.Executed],
    doc: PRD_APPROVED,
    issues: [ISSUE_DONE],
  },
  [TopicStage.Building]: {
    startDaysAgo: 44,
    staggerDays: 3,
    prd: [
      DocumentStatus.Draft,
      DocumentStatus.InReview,
      DocumentStatus.ChangesRequested,
      DocumentStatus.InReview,
      DocumentStatus.Approved,
    ],
    plan: PRD_APPROVED,
    doc: PRD_APPROVED,
    issues: [
      ISSUE_DONE,
      [IssueStatus.Todo, IssueStatus.InProgress],
      [IssueStatus.Todo, IssueStatus.InProgress, IssueStatus.InReview],
      [IssueStatus.Backlog, IssueStatus.Todo],
    ],
  },
  [TopicStage.Reviewing]: {
    startDaysAgo: 27,
    staggerDays: 2,
    prd: PRD_APPROVED,
    plan: [DocumentStatus.Draft, DocumentStatus.InReview],
    doc: [DocumentStatus.Draft, DocumentStatus.InReview],
    issues: [
      [IssueStatus.Triage, IssueStatus.Todo],
      [IssueStatus.Triage, IssueStatus.Backlog],
    ],
  },
  [TopicStage.Drafting]: {
    startDaysAgo: 15,
    staggerDays: 2,
    prd: [DocumentStatus.Draft, DocumentStatus.InReview],
    plan: [DocumentStatus.Draft],
    doc: [DocumentStatus.Draft],
    issues: [[IssueStatus.Triage]],
  },
  [TopicStage.Revising]: {
    startDaysAgo: 19,
    staggerDays: 2,
    prd: [
      DocumentStatus.Draft,
      DocumentStatus.InReview,
      DocumentStatus.ChangesRequested,
    ],
    plan: [DocumentStatus.Draft],
    doc: [DocumentStatus.Draft],
    issues: [[IssueStatus.Triage]],
  },
  [TopicStage.Shelved]: {
    startDaysAgo: 52,
    staggerDays: 2,
    prd: [...PRD_APPROVED, DocumentStatus.Obsolete],
    plan: [DocumentStatus.Draft, DocumentStatus.Obsolete],
    doc: [DocumentStatus.Draft, DocumentStatus.Obsolete],
    issues: [[IssueStatus.Backlog, IssueStatus.Canceled]],
  },
};

/**
 * A building topic every so often has one issue stuck on a dependency, so the
 * board shows a blocked card the way a real sprint does.
 */
const BLOCKED_EVERY_NTH_BUILDING_TOPIC = 3;

export function planBaseSeedContent(
  roster: SeedRoster,
  now: Date,
  catalog: readonly CatalogProject[] = PROJECT_CATALOG
): BaseSeedContentPlan {
  const people = new RosterCursor(roster);
  const stageCounts = new Map<TopicStage, number>();
  const projects: PlannedProject[] = [];
  const documents: PlannedDocument[] = [];
  for (const [projectIndex, project] of catalog.entries()) {
    const leadId = people.lead(project.lead);
    const projectDocuments: PlannedDocument[] = [];
    for (const topic of project.topics) {
      const ordinal = stageCounts.get(topic.stage) ?? 0;
      stageCounts.set(topic.stage, ordinal + 1);
      projectDocuments.push(
        ...planTopic({ project, projectIndex, topic, ordinal, people, now })
      );
    }
    documents.push(...projectDocuments);
    projects.push(planProject(project, leadId, projectDocuments, now));
  }
  return { projects, documents };
}

function planProject(
  project: CatalogProject,
  leadId: string,
  documents: readonly PlannedDocument[],
  now: Date
): PlannedProject {
  const created = Math.min(...documents.map((doc) => doc.createdAt.getTime()));
  const updated = Math.max(...documents.map((doc) => doc.updatedAt.getTime()));
  return {
    baseKey: project.baseKey,
    name: project.name,
    description: project.description,
    priority: project.priority,
    status: projectStatus(project.topics),
    leadId,
    createdAt: clampToPast(created - PROJECT_LEAD_TIME_DAYS * DAY_MS, now),
    updatedAt: clampToPast(updated, now),
  };
}

function projectStatus(topics: readonly CatalogTopic[]): ProjectStatus {
  const stages = new Set(topics.map((topic) => topic.stage));
  if (stages.has(TopicStage.Building) || stages.has(TopicStage.Reviewing)) {
    return ProjectStatus.InProgress;
  }
  if (stages.has(TopicStage.Shipped)) {
    return ProjectStatus.Completed;
  }
  return ProjectStatus.NotStarted;
}

type TopicInput = {
  readonly project: CatalogProject;
  readonly projectIndex: number;
  readonly topic: CatalogTopic;
  /** The topic's position among topics of the same stage. */
  readonly ordinal: number;
  readonly people: RosterCursor;
  readonly now: Date;
};

function planTopic(input: TopicInput): PlannedDocument[] {
  const { topic, ordinal, people, now } = input;
  const shape = STAGE_SHAPES[topic.stage];
  const start =
    now.getTime() -
    (shape.startDaysAgo - (ordinal % 4) * shape.staggerDays) * DAY_MS +
    ((ordinal * 5) % 9) * HOUR_MS;
  const clock = new TopicClock(start, now);
  const prdAuthor = topic.adminOwned ? people.admin : people.next(SeedRole.Pm);
  const planAuthor = people.next(SeedRole.Engineer);
  const documents: PlannedDocument[] = [];
  const base = {
    projectIndex: input.projectIndex,
    topic: topic.title,
  };
  documents.push(
    {
      ...base,
      ...clock.document(0, shape.prd),
      subtype: DocumentType.Prd,
      title: topic.title,
      priority: topic.priority,
      createdById: prdAuthor,
      assigneeId: prdAuthor,
      reviewerId: planAuthor,
    },
    {
      ...base,
      ...clock.document(3, shape.plan),
      subtype: DocumentType.ImplementationPlan,
      title: `Plan: ${topic.title}`,
      priority: topic.priority,
      createdById: planAuthor,
      assigneeId: planAuthor,
      reviewerId: prdAuthor,
    }
  );
  if (topic.doc) {
    const docAuthor = supportingDocAuthor(topic, people);
    documents.push({
      ...base,
      ...clock.document(2, shape.doc),
      subtype: DocumentType.Doc,
      title: supportingDocTitle(topic.doc, topic.title),
      priority: shiftPriority(topic.priority, -1),
      createdById: docAuthor,
      assigneeId: docAuthor,
      reviewerId: docAuthor === prdAuthor ? planAuthor : prdAuthor,
    });
  }
  for (const [position, title] of topic.issues.entries()) {
    const assigneeId = issueAssignee(input, position);
    documents.push({
      ...base,
      ...clock.document(6 + position, issueHistory(input, position)),
      subtype: DocumentType.Feature,
      title,
      priority: shiftPriority(
        topic.priority,
        ISSUE_PRIORITY_STEPS[position % ISSUE_PRIORITY_STEPS.length] ?? 0
      ),
      createdById: issueCreator(
        assigneeId,
        position,
        { prdAuthor, planAuthor },
        people
      ),
      assigneeId,
      reviewerId: assigneeId,
    });
  }
  return documents;
}

function supportingDocAuthor(topic: CatalogTopic, people: RosterCursor) {
  if (topic.adminOwned) {
    return people.admin;
  }
  return topic.doc === SupportingDocKind.Design
    ? people.next(SeedRole.Designer)
    : people.next(SeedRole.Engineer);
}

function supportingDocTitle(kind: SupportingDocKind, topic: string): string {
  return kind === SupportingDocKind.Design
    ? `Design: ${topic}`
    : `Decision record: ${topic}`;
}

function issueHistory(input: TopicInput, position: number): ArtifactStatus[] {
  const shape = STAGE_SHAPES[input.topic.stage];
  const lastIndex = shape.issues.length - 1;
  const history = [...(shape.issues[Math.min(position, lastIndex)] ?? [])];
  const blocked =
    input.topic.stage === TopicStage.Building &&
    input.ordinal % BLOCKED_EVERY_NTH_BUILDING_TOPIC ===
      BLOCKED_EVERY_NTH_BUILDING_TOPIC - 1 &&
    position === input.topic.issues.length - 1;
  if (blocked) {
    history.push(IssueStatus.Blocked);
  }
  return history;
}

/**
 * Engineers take most issues. Projects a designer leads give the designer
 * every other one, and the signed-in person's own topics give them the early
 * ones, which in a building topic are done, in progress and in review.
 */
function issueAssignee(input: TopicInput, position: number): string {
  const { project, topic, people } = input;
  if (topic.adminOwned && position < 3) {
    return people.admin;
  }
  if (project.lead === SeedRole.Designer && position % 2 === 1) {
    return people.next(SeedRole.Designer);
  }
  return people.next(SeedRole.Engineer);
}

/**
 * The PM files feature issues and the plan's engineer files the rest; an issue
 * handed to the signed-in person is always filed by someone else, so it reads
 * as assigned to them rather than self-assigned.
 */
function issueCreator(
  assigneeId: string,
  position: number,
  authors: { prdAuthor: string; planAuthor: string },
  people: RosterCursor
): string {
  const creator = position % 2 === 0 ? authors.prdAuthor : authors.planAuthor;
  if (assigneeId === people.admin && creator === people.admin) {
    return authors.planAuthor === people.admin
      ? people.next(SeedRole.Pm)
      : authors.planAuthor;
  }
  return creator;
}

function shiftPriority(priority: Priority, step: number): Priority {
  const index = PRIORITY_ORDER.indexOf(priority) + step;
  const clamped = Math.max(0, Math.min(PRIORITY_ORDER.length - 1, index));
  return PRIORITY_ORDER[clamped] ?? priority;
}

function clampToPast(time: number, now: Date): Date {
  return new Date(Math.min(time, now.getTime() - LATEST_TOUCH_MS));
}

/**
 * A topic's documents are created in order after its PRD (`offsetDays`), and
 * each status change after the first takes a day or two. A document still in
 * an open status was last touched some time in the last few days; one in a
 * settled status stopped when that status landed.
 */
class TopicClock {
  private touches = 0;
  private readonly start: number;
  private readonly now: Date;
  /** Varies the recent touches between topics, so projects do not all tie. */
  private readonly spread: number;

  constructor(start: number, now: Date) {
    this.start = start;
    this.now = now;
    this.spread = Math.floor(start / HOUR_MS) % RECENT_TOUCH_WINDOW_HOURS;
  }

  document(
    offsetDays: number,
    history: readonly ArtifactStatus[]
  ): Pick<PlannedDocument, "createdAt" | "updatedAt" | "status" | "history"> {
    this.touches += 1;
    const created = this.start + offsetDays * DAY_MS + this.touches * HOUR_MS;
    const settled = created + (history.length - 1) * 2 * DAY_MS;
    const status = history.at(-1);
    if (!status) {
      throw new Error("a planned document needs at least one status");
    }
    const hoursAgo =
      ((this.spread + this.touches * 7) % RECENT_TOUCH_WINDOW_HOURS) + 2;
    const recent = this.now.getTime() - hoursAgo * HOUR_MS;
    const updated = OPEN_STATUSES.has(status)
      ? Math.max(settled, recent)
      : settled;
    return {
      createdAt: clampToPast(created, this.now),
      updatedAt: clampToPast(Math.max(updated, created), this.now),
      status,
      history,
    };
  }
}

/** Hands out people by role in rotation, falling back to the signed-in person. */
class RosterCursor {
  readonly admin: string;
  private readonly pools: Readonly<Record<SeedRole, readonly string[]>>;
  private readonly cursors = new Map<SeedRole, number>();
  private readonly leadCursors = new Map<SeedRole, number>();

  constructor(roster: SeedRoster) {
    this.admin = roster.admin;
    this.pools = {
      [SeedRole.Pm]: roster.pms,
      [SeedRole.Engineer]: roster.engineers,
      [SeedRole.Designer]: roster.designers,
      [SeedRole.Admin]: [roster.admin],
    };
  }

  next(role: SeedRole): string {
    const pool = this.pools[role];
    const cursor = this.cursors.get(role) ?? 0;
    this.cursors.set(role, cursor + 1);
    return pool[cursor % pool.length] ?? this.admin;
  }

  /** Leads rotate on their own, so the work rotation does not skew them. */
  lead(role: SeedRole): string {
    const pool = this.pools[role];
    const cursor = this.leadCursors.get(role) ?? 0;
    this.leadCursors.set(role, cursor + 1);
    return pool[cursor % pool.length] ?? this.admin;
  }
}
