import type {
  ArtifactLinkEndpoint,
  ArtifactLinkWithEndpoints,
  ArtifactSubtype,
} from "@repo/api/src/types/artifact";
import {
  ArtifactType,
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import { AttachmentPurposeSelector } from "@repo/api/src/types/attachment";
import { Priority } from "@repo/api/src/types/common";
import type {
  DocumentDetail,
  DocumentWithProject,
} from "@repo/api/src/types/document";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { TagColor } from "@repo/api/src/types/tag";
import type { BasicUser } from "@repo/api/src/types/user";
import { customFieldKeys } from "@repo/app/custom-fields/hooks/use-custom-fields";
import { artifactFavoriteKeys } from "@repo/app/documents/hooks/artifact-favorite-keys";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { artifactLinkKeys } from "@repo/app/documents/hooks/use-artifact-links";
import { attachmentKeys } from "@repo/app/documents/hooks/use-attachments";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { teamKeys } from "@repo/app/teams/hooks/use-teams";
import { userKeys } from "@repo/app/users/hooks/use-users";
import type { Meta, StoryObj } from "@storybook/react";
import { VersionedDocumentEditorContainer } from "@/app/(authenticated)/[orgSlug]/components/versioned-document-editor-container";
import { AppScreenShell, ORG_SLUG } from "./app-shell";
import { StoryIssueEditor } from "./issue-detail-editor";

/**
 * Issue detail fixtures and screen states. StoryIssueEditor composes the real
 * scaffold and sections, including PlanSection, with story-scoped navigation.
 */

const ORG_ID = "org_closedloop";

const OTTILIE: BasicUser = {
  id: "user-ottilie",
  firstName: "Ottilie",
  lastName: "Eye",
  email: "ottilie@closedloop.ai",
  avatarUrl: null,
};

const MARISOL: BasicUser = {
  id: "user-marisol",
  firstName: "Marisol",
  lastName: "Ashgrove",
  email: "marisol@closedloop.ai",
  avatarUrl: null,
};

const PROJECT = {
  id: "project-session-reliability",
  name: "Session Reliability",
  teams: [{ id: "team-platform", name: "Platform" }],
};

const ISSUE_FIXTURE_DATE = new Date("2026-09-15T14:00:00.000Z");

function buildIssueDetail({
  id,
  slug,
  title,
  status,
  content,
  assignee = OTTILIE,
}: {
  id: string;
  slug: string;
  title: string;
  status: IssueStatus;
  content: string;
  assignee?: BasicUser | null;
}): DocumentDetail {
  return {
    id,
    organizationId: ORG_ID,
    projectId: PROJECT.id,
    type: DocumentType.Feature,
    title,
    slug,
    fileName: null,
    status,
    priority: Priority.High,
    latestVersion: 1,
    createdById: OTTILIE.id,
    createdBy: OTTILIE,
    assigneeId: assignee?.id ?? null,
    assignee,
    approverId: null,
    approver: null,
    repositorySnapshot: { repositories: [], source: SnapshotSource.None },
    templateForType: null,
    sortOrder: 1,
    createdAt: ISSUE_FIXTURE_DATE,
    updatedAt: ISSUE_FIXTURE_DATE,
    project: PROJECT,
    customFields: [],
    tags: [
      { color: TagColor.Blue, id: "tag-reliability", name: "Reliability" },
    ],
    version: {
      content,
      createdAt: ISSUE_FIXTURE_DATE,
      createdById: OTTILIE.id,
      documentId: id,
      id: `${id}-v1`,
      version: 1,
    },
    latestVersionContent: content,
  };
}

const ISSUE_DEFAULT_MARKDOWN = `# Fix Duplicate Webhook Delivery on Retry

## Problem

When a downstream webhook consumer times out or returns a 5xx, the retry
worker resends the SAME event instead of checking whether the original
delivery already landed. A consumer without an idempotency key processes the
event twice, which is what triggered last week's double-charge report.

## Reproduction

1. Trigger a webhook delivery to an endpoint that responds slowly (>10s).
2. Let the delivery attempt time out.
3. Watch the retry worker fire attempt 2 while attempt 1 is still in flight
   server-side.
4. Consumer logs show the same \`event.id\` processed twice.

## Expected Behavior

The retry worker should check the delivery ledger for an in-flight or
already-acknowledged attempt before firing a retry, and skip the retry when
one is found.

## Notes

Related to the timeout tuning Ottilie shipped last sprint — that reduced how
OFTEN this fires but did not fix the root cause.
`;

const ISSUE_NO_PLAN_MARKDOWN = `# Session Heartbeat Drops After Reconnect

## Problem

After a desktop client reconnects following a network blip, the session
heartbeat sometimes never resumes. The session then shows as "stale" on the
dashboard even though the user is actively working.

## Reproduction

1. Start a session on desktop.
2. Kill network for 15-20 seconds (airplane mode works).
3. Restore network.
4. Watch the session card — heartbeat does not resume for roughly 1 in 5
   reconnects.

## Notes

Flagged by two team members this week. Still gathering repro steps before
scoping a fix — no plan yet.
`;

const ISSUE_DEFAULT = buildIssueDetail({
  content: ISSUE_DEFAULT_MARKDOWN,
  id: "iss-duplicate-webhook-retry",
  slug: "fix-duplicate-webhook-delivery-on-retry",
  status: IssueStatus.InProgress,
  title: "Fix Duplicate Webhook Delivery on Retry",
});

const ISSUE_NO_PLAN = buildIssueDetail({
  content: ISSUE_NO_PLAN_MARKDOWN,
  id: "iss-flaky-session-heartbeat",
  slug: "session-heartbeat-drops-after-reconnect",
  status: IssueStatus.Triage,
  title: "Session Heartbeat Drops After Reconnect",
});

const CONTEXT_DOC_PRD: DocumentWithProject = {
  id: "doc-prd-webhook-reliability",
  organizationId: ORG_ID,
  projectId: PROJECT.id,
  type: DocumentType.Prd,
  title: "Webhook Delivery Reliability PRD",
  slug: "webhook-delivery-reliability-prd",
  fileName: null,
  status: DocumentStatus.Approved,
  priority: Priority.High,
  latestVersion: 1,
  createdById: MARISOL.id,
  createdBy: MARISOL,
  assigneeId: MARISOL.id,
  assignee: MARISOL,
  approverId: OTTILIE.id,
  approver: OTTILIE,
  repositorySnapshot: { repositories: [], source: SnapshotSource.None },
  templateForType: null,
  sortOrder: 1,
  createdAt: new Date("2026-08-20T12:00:00.000Z"),
  updatedAt: new Date("2026-08-28T09:00:00.000Z"),
  project: PROJECT,
  tags: [],
};

const CONTEXT_DOC_POSTMORTEM: DocumentWithProject = {
  id: "doc-postmortem-duplicate-webhooks",
  organizationId: ORG_ID,
  projectId: PROJECT.id,
  type: DocumentType.Doc,
  title: "Incident Postmortem: Duplicate Webhook Sends",
  slug: "incident-postmortem-duplicate-webhooks",
  fileName: null,
  status: DocumentStatus.Approved,
  priority: null,
  latestVersion: 1,
  createdById: OTTILIE.id,
  createdBy: OTTILIE,
  assigneeId: OTTILIE.id,
  assignee: OTTILIE,
  approverId: null,
  approver: null,
  repositorySnapshot: { repositories: [], source: SnapshotSource.None },
  templateForType: null,
  sortOrder: 2,
  createdAt: new Date("2026-09-02T16:00:00.000Z"),
  updatedAt: new Date("2026-09-02T16:00:00.000Z"),
  project: PROJECT,
  tags: [],
};

const PROJECT_DOCUMENTS: DocumentWithProject[] = [
  CONTEXT_DOC_PRD,
  CONTEXT_DOC_POSTMORTEM,
];

const PLAN_MARKDOWN = `# Plan: Fix Duplicate Webhook Delivery on Retry

## Approach

Add a delivery-ledger check to the retry worker: before firing a retry,
look up the event's most recent attempt and skip the retry if it is still
in flight or already acknowledged.

## Steps

1. Add a \`delivery_attempts\` read to the retry worker's pre-flight check.
2. Skip the retry when an in-flight or acknowledged attempt exists for the
   same event id.
3. Backfill a metric for skipped-duplicate retries so we can see the fix
   working in production.

## Risk

Adds a synchronous read to the hot retry path. Load-test before merge.
`;

const PLAN_DOC: DocumentDetail = {
  id: "doc-plan-webhook-fix",
  organizationId: ORG_ID,
  projectId: PROJECT.id,
  type: DocumentType.ImplementationPlan,
  title: "Plan: Fix Duplicate Webhook Delivery on Retry",
  slug: "plan-fix-duplicate-webhook-delivery",
  fileName: null,
  status: DocumentStatus.InReview,
  priority: Priority.High,
  latestVersion: 1,
  createdById: OTTILIE.id,
  createdBy: OTTILIE,
  assigneeId: OTTILIE.id,
  assignee: OTTILIE,
  approverId: null,
  approver: null,
  repositorySnapshot: { repositories: [], source: SnapshotSource.None },
  templateForType: null,
  sortOrder: 1,
  createdAt: new Date("2026-09-16T10:00:00.000Z"),
  updatedAt: new Date("2026-09-16T15:00:00.000Z"),
  project: PROJECT,
  tags: [],
  version: {
    content: PLAN_MARKDOWN,
    createdAt: new Date("2026-09-16T15:00:00.000Z"),
    createdById: OTTILIE.id,
    documentId: "doc-plan-webhook-fix",
    id: "doc-plan-webhook-fix-v1",
    version: 1,
  },
  latestVersionContent: PLAN_MARKDOWN,
};

/** Maps a `DocumentWithProject` fixture to the `ArtifactLinkEndpoint` shape a
 * resolved artifact-link's `source`/`target` carries. `DocumentType` and
 * `ArtifactSubtype` share identical string values (both "PRD",
 * "IMPLEMENTATION_PLAN", "FEATURE", "DOC", …), so the direct cast is exact,
 * not lossy. Only load-bearing in the rare `CrossProjectDocumentRow` fallback
 * path (a linked document outside the current project) — every link fixture
 * below resolves through `documentsById` instead, but this keeps the
 * endpoint objects real and well-typed rather than stubbed. */
function documentToLinkEndpoint(
  doc: DocumentWithProject
): ArtifactLinkEndpoint {
  return {
    id: doc.id,
    organizationId: doc.organizationId,
    projectId: doc.projectId,
    type: ArtifactType.Document,
    subtype: doc.type as ArtifactSubtype,
    name: doc.title,
    slug: doc.slug,
    status: doc.status,
    priority: doc.priority,
    assigneeId: doc.assigneeId,
    assignee: doc.assignee,
    dueDate: null,
    externalUrl: null,
    sortOrder: doc.sortOrder,
    createdAt: doc.createdAt,
    createdById: doc.createdById,
    updatedAt: doc.updatedAt,
  };
}

const ISSUE_LINK_ENDPOINT = documentToLinkEndpoint(ISSUE_DEFAULT);

const CONTEXT_LINKS: ArtifactLinkWithEndpoints[] = [
  {
    id: "link-context-prd",
    organizationId: ORG_ID,
    sourceId: CONTEXT_DOC_PRD.id,
    targetId: ISSUE_DEFAULT.id,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-09-15T14:05:00.000Z"),
    source: documentToLinkEndpoint(CONTEXT_DOC_PRD),
    target: ISSUE_LINK_ENDPOINT,
  },
  {
    id: "link-context-postmortem",
    organizationId: ORG_ID,
    sourceId: CONTEXT_DOC_POSTMORTEM.id,
    targetId: ISSUE_DEFAULT.id,
    linkType: LinkType.RelatesTo,
    metadata: null,
    createdAt: new Date("2026-09-15T14:06:00.000Z"),
    source: documentToLinkEndpoint(CONTEXT_DOC_POSTMORTEM),
    target: ISSUE_LINK_ENDPOINT,
  },
];

const PLAN_LINK: ArtifactLinkWithEndpoints = {
  id: "link-issue-plan",
  organizationId: ORG_ID,
  sourceId: ISSUE_DEFAULT.id,
  targetId: PLAN_DOC.id,
  linkType: LinkType.Produces,
  metadata: null,
  createdAt: new Date("2026-09-16T10:05:00.000Z"),
  source: ISSUE_LINK_ENDPOINT,
  target: documentToLinkEndpoint(PLAN_DOC),
};

// ─────────────────────────────────────────────────────────────────────────
// Screen + fixture wiring
// ─────────────────────────────────────────────────────────────────────────

const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

type IssueDetailScreenProps = {
  /** Org-relative path the sidebar should mark as current. */
  activePath?: string;
  /** The issue fixture this story's fixture routes serve. Fixed per story,
   * not a control — see `argTypes.document` below. */
  document: DocumentDetail;
  /** The version `VersionedDocumentEditorContainer` opens on. Omit for the
   * latest (single-version fixtures throughout this file). */
  version?: number;
};

// `hideHeader`: the real content mounts the real production `Header` (via
// `StoryIssueEditorHeader`) inside the scaffold, same reasoning as
// Document Detail's own screen.
const IssueDetailScreen = ({
  activePath = "/issues",
  document,
  version,
}: IssueDetailScreenProps) => (
  <AppScreenShell activePath={activePath} hideHeader>
    <VersionedDocumentEditorContainer
      editor={StoryIssueEditor}
      slug={document.slug}
      version={version}
    />
  </AppScreenShell>
);

/**
 * The fixture routes + query-cache seeds an issue's mount needs — see the
 * file doc comment's crash-pattern section for why each entry is here.
 */
function appCoreParamsFor(
  issue: DocumentDetail,
  opts: {
    contextLinks?: ArtifactLinkWithEndpoints[];
    planLink?: ArtifactLinkWithEndpoints | null;
  } = {}
) {
  const { contextLinks = [], planLink = null } = opts;
  return {
    apiRoutes: [
      {
        method: "GET",
        path: `/documents/by-slug/${issue.slug}`,
        respond: () => issue,
      },
      {
        method: "POST",
        path: `/documents/${issue.id}/versions`,
        respond: ({ body }: FixtureRequestContext) => {
          const input = (body ?? {}) as { content?: string };
          const nextVersion = issue.latestVersion + 1;
          return {
            ...issue,
            latestVersion: nextVersion,
            latestVersionContent: input.content ?? issue.latestVersionContent,
            version: {
              ...issue.version,
              content: input.content ?? issue.version.content,
              id: `${issue.id}-v${nextVersion}`,
              version: nextVersion,
            },
          };
        },
      },
    ],
    queryData: [
      [userKeys.currentUser(), null],
      [artifactFavoriteKeys.list(), []],
      [
        attachmentKeys.listByPurpose(
          issue.id,
          AttachmentPurposeSelector.Context
        ),
        [],
      ],
      [
        attachmentKeys.listByPurpose(
          issue.id,
          AttachmentPurposeSelector.Inline
        ),
        [],
      ],
      [customFieldKeys.list({}), []],
      [documentKeys.list({ projectId: PROJECT.id }), PROJECT_DOCUMENTS],
      [documentKeys.detail(PLAN_DOC.id), PLAN_DOC],
      // DocumentEditorScaffold -> useDocumentMetadata -> useTeamMembers reads
      // one of these per PROJECT.teams entry unconditionally; unseeded, the
      // harness's fixture transport falls back to an unmatched-GET default of
      // `{}`, and transformMembers's `for (const member of members)` throws
      // on the non-array (confirmed via the exact "members is not iterable"
      // crash this seed fixes).
      ...PROJECT.teams.map((team) => [teamKeys.members(team.id), []] as const),
      [
        artifactLinkKeys.list({
          artifactId: issue.id,
          direction: LinkDirection.Source,
          linkType: undefined,
          mode: undefined,
          maxDepth: undefined,
          resolved: true,
        }),
        contextLinks,
      ],
      [
        artifactLinkKeys.list({
          artifactId: issue.id,
          direction: LinkDirection.Target,
          linkType: undefined,
          mode: undefined,
          maxDepth: undefined,
          resolved: true,
        }),
        planLink ? [planLink] : [],
      ],
      [
        artifactLinkKeys.list({
          artifactId: issue.id,
          direction: LinkDirection.Target,
          linkType: undefined,
          mode: LinkQueryMode.Tree,
          maxDepth: undefined,
          resolved: true,
        }),
        // No branches yet — a real, common resting state for an
        // issue whose plan has not built anything yet. See file doc comment.
        [],
      ],
    ],
  };
}

/**
 * The Issue editor at `/documents/[slug]`: context and plan sections around
 * the real collaborative editor, reached from a project's Issues list.
 */
const meta = {
  title: "Surfaces v1.0/Issues/Issue Detail",
  component: IssueDetailScreen,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    activePath: {
      options: NAV_PATHS,
      control: { type: "select" },
      description: "Which sidebar destination renders as current.",
      table: { category: "Shell" },
    },
    document: {
      description:
        "The issue fixture this story mounts. Not a live control — the object is too structured for the Controls panel; switch between the named stories below instead.",
      table: { disable: true },
    },
    version: {
      control: { type: "number", min: 1 },
      description:
        "The version VersionedDocumentEditorContainer opens on. Omit for latest.",
      table: { category: "State" },
    },
  },
  args: {
    activePath: "/issues",
    document: ISSUE_DEFAULT,
  },
  parameters: {
    layout: "fullscreen",
    // A fullscreen Surface, inlined into the Docs page's own prose-width
    // column, squeezes real components into far less width than they ever
    // get in the product. `inline: false` renders the Docs preview in its
    // own full-width iframe instead, the documented Storybook fix for
    // exactly this mismatch.
    docs: { story: { inline: false, iframeHeight: 1000 } },
    appCore: appCoreParamsFor(ISSUE_DEFAULT, {
      contextLinks: CONTEXT_LINKS,
      planLink: PLAN_LINK,
    }),
  },
} satisfies Meta<typeof IssueDetailScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A populated issue mid-flight: real markdown body, two real linked context
 * documents (a PRD and an incident postmortem), a real linked implementation
 * plan. Build sits in its real empty state — this issue's plan has not built
 * anything yet. */
export const Default: Story = {};

/**
 * No settled read yet: the real `VersionedDocumentEditorContainer`'s own
 * `isLoading` branch, the real `PageLoadingSpinner` — not a hand-rolled one.
 * The GET fixture route below never resolves, the same technique Document
 * Detail's own `Loading` story uses.
 */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: `/documents/by-slug/${ISSUE_DEFAULT.slug}`,
          respond: () => new Promise<never>(() => undefined),
        },
      ],
    },
  },
};

/**
 * A freshly-triaged issue with real content but no plan generated yet, no
 * context linked yet — the real `PlanSection`/`ContextSection` empty states,
 * not invented ones.
 */
export const NoPlanYet: Story = {
  name: "No plan yet",
  args: { document: ISSUE_NO_PLAN },
  parameters: {
    appCore: appCoreParamsFor(ISSUE_NO_PLAN),
  },
};
