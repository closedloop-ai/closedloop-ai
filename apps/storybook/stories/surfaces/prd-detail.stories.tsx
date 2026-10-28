import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { AttachmentPurposeSelector } from "@repo/api/src/types/attachment";
import { Priority } from "@repo/api/src/types/common";
import {
  type DocumentDetail,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  IssueStatus,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { TagColor } from "@repo/api/src/types/tag";
import {
  ApproverRole,
  type BasicUser,
  type User,
} from "@repo/api/src/types/user";
import {
  DocumentEditorScaffold,
  type ScaffoldSlotContext,
} from "@repo/app/documents/components/document-editor-scaffold";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { AssociatedArtifactsSection } from "@repo/app/documents/editors/prds/detail/components/associated-artifacts-section";
import { artifactFavoriteKeys } from "@repo/app/documents/hooks/artifact-favorite-keys";
import { attachmentKeys } from "@repo/app/documents/hooks/use-attachments";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { teamKeys } from "@repo/app/teams/hooks/use-teams";
import { userKeys } from "@repo/app/users/hooks/use-users";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { Meta, StoryObj } from "@storybook/react";
import {
  DownloadIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RotateCcwIcon,
  TrashIcon,
} from "lucide-react";
import { VersionedDocumentEditorContainer } from "@/app/(authenticated)/[orgSlug]/components/versioned-document-editor-container";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { AppScreenShell, ORG_SLUG } from "./app-shell";

/**
 * The org-level PRD editor (ISS-4382-adjacent): `/documents/[slug]`, the detail
 * page every Feature/Plan this PRD produced traces back to, and the closest
 * real precedent this file follows is `Surfaces/Documents/Document Detail`.
 * There is no separate PRDs listing route — PRDs are reached via the
 * Documents index filtered by type, or via a Project's own "PRDs" tab — so,
 * matching Surfaces/Agents' "Agent Detail"-only precedent, this is the only
 * PRD surface.
 *
 * WHY the web `DocumentEditor` (`apps/app/app/(authenticated)/[orgSlug]/
 * documents/[slug]/document-editor.tsx`) is not mounted directly, same shape as Document Detail's
 * own reasoning: it calls `useOrgSlug()` at its own top level, and so does
 * `PRDEditorHeader`. `useOrgSlug()` (`apps/app/hooks/use-org-slug.ts`) calls
 * Clerk's own `useAuth()` / `useOrganization()`, and no `<ClerkProvider>`
 * exists anywhere in this Storybook by design. `StoryPRDEditor` /
 * `StoryPRDEditorHeader` below are `prd-editor.tsx` / `prd-editor-header.tsx`
 * copied verbatim with that ONE call replaced by `AppScreenShell`'s own
 * exported `ORG_SLUG`, same technique as `StoryDocumentEditor` /
 * `StoryDocumentEditorHeader` in `document-detail.stories.tsx` — nothing else
 * changed. `VersionedDocumentEditorContainer` itself is mounted REAL and
 * unmodified (confirmed Clerk-free by reading its source, same as the
 * Document Detail file), doing the same job it does in production.
 *
 * `MoveEntityDialog` — unlike Document Detail, which passes `hideMoveAction`
 * to skip it entirely — renders here because `PRDEditor` does NOT set
 * `hideMoveAction`, matching the real page. It calls `useProjects()`
 * UNCONDITIONALLY on every render (no `enabled` gate), so this mounts even
 * at rest. Its query key (`GET /projects`) is deliberately left UNSEEDED: read
 * `fixture-fetch.ts`'s own `LIST_READ_PATH_SUFFIXES`, which already covers
 * `/projects` (and `/users`) with a safe `[]` default for exactly this reason
 * ("`useSessionProjectNameResolver` iterates `useProjects()`'s data" — the
 * same shape of bug this avoids here). The Move dialog is real and clickable;
 * it just always shows "No available projects", an honest, harmless
 * limitation of a fixture with one org and no other projects wired up.
 *
 * `useResolvedArtifactLinks` / `useDeleteArtifactLink`
 * (`AssociatedArtifactsSection`, real and unmodified — confirmed Clerk-free)
 * get a REAL `GET /artifact-links/resolved` + `DELETE /artifact-links/*`
 * fixture route below, not just a `queryData` seed. This is load-bearing, not
 * decoration: `useUpdateDocument` (the same mutation this section's inline
 * status/priority/assignee edits use) invalidates `artifactLinkKeys` on
 * success via `invalidateArtifactCaches`, and `useDeleteArtifactLink`'s own
 * `onSuccess` does too — either interaction forces a REFETCH through the real
 * `queryFn`, which a `queryData`-only seed does not survive (the refetch hits
 * the fixture transport's unmatched-GET `{}` default, and `fetchAllResolved
 * LinkPages` spreads `page.items` off it, which is `undefined` — a real,
 * confirmed crash, same shape as the favorites one below). Registering the
 * route instead makes both the inline edit AND the "Detach" action genuinely
 * safe to click, not merely rendered.
 *
 * `artifactFavoriteKeys.list()` (the `FavoriteButton` in the header, exactly
 * the lesson-2 crash pattern) gets BOTH a `queryData` seed (so it renders its
 * final state from the first paint, no flash) AND a `GET /artifacts/favorites`
 * fixture route (so clicking the star — a real, reachable interaction here,
 * unlike a purely static read — survives the toggle mutation's own
 * `invalidateQueries(artifactFavoriteKeys.list())` instead of crashing on the
 * unmatched-GET `{}` default the way an unclicked `queryData`-only seed would
 * once invalidated).
 *
 * Verification note: like both precedent Surfaces files, this was checked by
 * reading every component, hook, and query key it touches (imports, prop
 * contracts, invalidation targets), not by rendering it in a live browser —
 * no interactive Storybook session was available while writing it.
 */

const DOCUMENT_ORG_ID = "org_closedloop";
const USER_FIXTURE_DATE = new Date("2026-01-01T00:00:00.000Z");

function toBasicUser(user: User): BasicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
  };
}

function orgUser({
  id,
  firstName,
  lastName,
  email,
  role,
}: {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: ApproverRole;
}): User {
  return {
    id,
    clerkId: `clerk_${id}`,
    organizationId: DOCUMENT_ORG_ID,
    email,
    firstName,
    lastName,
    avatarUrl: null,
    phoneNumber: null,
    role,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: USER_FIXTURE_DATE,
    updatedAt: USER_FIXTURE_DATE,
  };
}

const OTTILIE_USER = orgUser({
  id: "user-ottilie",
  firstName: "Ottilie",
  lastName: "Eye",
  email: "ottilie@closedloop.ai",
  role: ApproverRole.Pm,
});
const PASCOE_USER = orgUser({
  id: "user-pascoe",
  firstName: "Pascoe",
  lastName: "Birchall",
  email: "pascoe@closedloop.ai",
  role: ApproverRole.Engineer,
});
const MARISOL_USER = orgUser({
  id: "user-marisol",
  firstName: "Marisol",
  lastName: "Ashgrove",
  email: "marisol@closedloop.ai",
  role: ApproverRole.TechLead,
});

const OTTILIE = toBasicUser(OTTILIE_USER);
const PASCOE = toBasicUser(PASCOE_USER);

/** Seeds `GET /users` (`useOrganizationUsers`, the Associated Artifacts
 * assignee picker). Not required for crash-safety — `fixture-fetch.ts`'s
 * `LIST_READ_PATH_SUFFIXES` already defaults an unmatched `/users` read to
 * `[]` — but real names beat an empty picker. */
const ORG_USERS_FIXTURE: User[] = [OTTILIE_USER, PASCOE_USER, MARISOL_USER];

type BuildPrdDetailArgs = {
  id: string;
  slug: string;
  title: string;
  status: DocumentStatus;
  priority?: Priority | null;
  /** Content of the version this object's own `version` field represents. */
  content: string;
  /** The PRD's real latest version number. Defaults to 1 (single-version). */
  latestVersion?: number;
  /** Which version `version.content` is. Defaults to `latestVersion`. */
  versionNumber?: number;
  /** Content of the LATEST version — see `DocumentDetail.latestVersionContent`'s
   * own contract. Defaults to `content`. */
  latestContent?: string;
  project?: DocumentWithProject["project"];
  assignee?: BasicUser | null;
  tags?: DocumentWithProject["tags"];
};

function buildPrdDetail({
  id,
  slug,
  title,
  status,
  priority = null,
  content,
  latestVersion = 1,
  versionNumber = latestVersion,
  latestContent = content,
  project = null,
  assignee = OTTILIE,
  tags = [],
}: BuildPrdDetailArgs): DocumentDetail {
  return {
    id,
    organizationId: DOCUMENT_ORG_ID,
    projectId: project?.id ?? null,
    type: DocumentType.Prd,
    title,
    slug,
    fileName: null,
    status,
    priority,
    latestVersion,
    createdById: OTTILIE.id,
    createdBy: OTTILIE,
    assigneeId: assignee?.id ?? null,
    assignee,
    approverId: null,
    approver: null,
    repositorySnapshot: { repositories: [], source: SnapshotSource.None },
    templateForType: null,
    sortOrder: 1,
    createdAt: USER_FIXTURE_DATE,
    updatedAt: USER_FIXTURE_DATE,
    project,
    tags,
    version: {
      content,
      createdAt: USER_FIXTURE_DATE,
      createdById: OTTILIE.id,
      documentId: id,
      id: `${id}-v${versionNumber}`,
      version: versionNumber,
    },
    latestVersionContent: latestContent,
  };
}

const TEAM_PLATFORM = { id: "team-platform", name: "Platform" };
const PROJECT_INBOX: DocumentWithProject["project"] = {
  id: "proj-inbox-notifications",
  name: "Inbox & Notifications",
  teams: [TEAM_PLATFORM],
};

const PRD_MARKDOWN_V1 = `# Unified Inbox Unread Signal

## Problem

The inbox currently shows two separate unread signals inherited from
Liveblocks' default styling: a full-row background tint and a separate
unread dot, both driven by the same boolean. Nothing in the codebase
documents this as a deliberate design choice.

## Goals

- One unread signal per row, matching how every other colored-border or
  dot indicator in this codebase already works.
- Keep the remaining signal legible in both light and dark themes.

## Proposal

Drop the full-row tint and keep the dot.
`;

const PRD_MARKDOWN_V2 = `# Unified Inbox Unread Signal

## Problem

The inbox currently shows two separate unread signals inherited from
Liveblocks' default styling: a full-row background tint and a separate
unread dot, both driven by the same boolean. Nothing in the codebase
documents this as a deliberate design choice, and it reads as unfamiliar
next to every other status signal in the product, which use exactly one
indicator per state.

## Goals

- One unread signal per row, matching how every other colored-border or
  dot indicator in this codebase already works.
- Keep the remaining signal legible in both light and dark themes.
- Document the override the same way every other Liveblocks default in
  this codebase is already documented, so the next person who touches
  the inbox does not have to rediscover this.

## Non-goals

- Redesigning inbox grouping, filtering, or bulk read/unread actions.
- Changing what counts as "unread" server-side.

## Proposal

Drop the full-row tint and keep the dot. The dot alone already carries
the same information the tint does, at the same glance cost every other
status dot in the app already asks of a user.

## Rollout

No flag: this is a pure visual fix with no data-model change. Ship it as
a CSS override on the inbox row component, then decompose this PRD into
an Issue for the change and a follow-up Issue for a contrast regression
test on the dot in both themes.
`;

const PRD_DEFAULT = buildPrdDetail({
  content: PRD_MARKDOWN_V2,
  id: "prd-inbox-unread-signal",
  priority: Priority.High,
  project: PROJECT_INBOX,
  slug: "unified-inbox-unread-signal",
  status: DocumentStatus.InReview,
  tags: [
    { color: TagColor.Blue, id: "tag-inbox", name: "Inbox" },
    { color: TagColor.Amber, id: "tag-design-debt", name: "Design Debt" },
  ],
  title: "Unified Inbox Unread Signal",
});

const PRD_HISTORY_LATEST = buildPrdDetail({
  content: PRD_MARKDOWN_V2,
  id: PRD_DEFAULT.id,
  latestVersion: 2,
  priority: PRD_DEFAULT.priority,
  project: PROJECT_INBOX,
  slug: PRD_DEFAULT.slug,
  status: DocumentStatus.InReview,
  tags: PRD_DEFAULT.tags,
  title: PRD_DEFAULT.title,
  versionNumber: 2,
});

const PRD_HISTORY_V1 = buildPrdDetail({
  content: PRD_MARKDOWN_V1,
  id: PRD_DEFAULT.id,
  latestContent: PRD_MARKDOWN_V2,
  latestVersion: 2,
  priority: PRD_DEFAULT.priority,
  project: PROJECT_INBOX,
  slug: PRD_DEFAULT.slug,
  status: DocumentStatus.InReview,
  tags: PRD_DEFAULT.tags,
  title: PRD_DEFAULT.title,
  versionNumber: 1,
});

const PRD_FRESH_MARKDOWN = `# Session Retry Backoff Policy

## Problem

A dropped connection during a session currently retries on a fixed
1-second interval with no backoff, so a genuinely down compute target
gets hammered with retries until a human notices and cancels the run.

## Goals

- Exponential backoff with a sane ceiling, so a real outage degrades to
  occasional retries rather than a retry storm.
- No change to the retry behavior for a merely slow response.

## Proposal

Generated from the incident notes on the retry-storm postmortem. Needs a
pass with the team before this goes further — proposal section is a
first draft, not yet reviewed.
`;

const PRD_FRESH = buildPrdDetail({
  content: PRD_FRESH_MARKDOWN,
  id: "prd-session-retry-backoff",
  priority: Priority.Medium,
  project: null,
  slug: "session-retry-backoff-policy",
  status: DocumentStatus.Draft,
  tags: [],
  title: "Session Retry Backoff Policy",
});

/** Two real Features this PRD produced, one of which produced its own Plan —
 * exercises `AssociatedArtifactsSection`'s depth-2 indentation, not just a
 * flat depth-1 list. */
function artifactEndpoint({
  id,
  name,
  slug,
  subtype,
  status,
  priority = null,
  assignee = null,
  sortOrder = 1,
}: {
  id: string;
  name: string;
  slug: string;
  subtype: ArtifactSubtype;
  status: string;
  priority?: Priority | null;
  assignee?: BasicUser | null;
  sortOrder?: number;
}): ArtifactLinkEndpoint {
  return {
    id,
    organizationId: DOCUMENT_ORG_ID,
    projectId: PROJECT_INBOX?.id ?? null,
    type: ArtifactType.Document,
    subtype,
    name,
    slug,
    status,
    priority,
    assigneeId: assignee?.id ?? null,
    assignee,
    dueDate: null,
    externalUrl: null,
    sortOrder,
    createdAt: USER_FIXTURE_DATE,
    createdById: OTTILIE.id,
    updatedAt: USER_FIXTURE_DATE,
  };
}

const PRD_ENDPOINT = artifactEndpoint({
  id: PRD_DEFAULT.id,
  name: PRD_DEFAULT.title,
  priority: PRD_DEFAULT.priority,
  slug: PRD_DEFAULT.slug,
  status: PRD_DEFAULT.status,
  subtype: ArtifactSubtype.Prd,
});

const FEAT_DROP_TINT = artifactEndpoint({
  assignee: OTTILIE,
  id: "feat-drop-row-tint",
  name: "Drop Inbox Row Tint Override",
  priority: Priority.High,
  slug: "drop-inbox-row-tint-override",
  sortOrder: 1,
  status: IssueStatus.InProgress,
  subtype: ArtifactSubtype.Feature,
});

const FEAT_CONTRAST_TEST = artifactEndpoint({
  id: "feat-contrast-test",
  name: "Add Contrast Regression Test for Unread Dot",
  priority: Priority.Medium,
  slug: "contrast-regression-test-unread-dot",
  sortOrder: 2,
  status: IssueStatus.Backlog,
  subtype: ArtifactSubtype.Feature,
});

const PLAN_REMOVE_TINT = artifactEndpoint({
  assignee: PASCOE,
  id: "plan-remove-row-tint",
  name: "Implementation Plan: Remove Inbox Row Tint",
  slug: "implementation-plan-remove-inbox-row-tint",
  sortOrder: 1,
  status: DocumentStatus.Draft,
  subtype: ArtifactSubtype.ImplementationPlan,
});

const ASSOCIATED_LINKS: ArtifactLinkWithEndpoints[] = [
  {
    createdAt: USER_FIXTURE_DATE,
    id: "link-prd-feat-tint",
    linkType: LinkType.Produces,
    metadata: null,
    organizationId: DOCUMENT_ORG_ID,
    source: PRD_ENDPOINT,
    sourceId: PRD_DEFAULT.id,
    target: FEAT_DROP_TINT,
    targetId: FEAT_DROP_TINT.id,
  },
  {
    createdAt: USER_FIXTURE_DATE,
    id: "link-prd-feat-contrast",
    linkType: LinkType.Produces,
    metadata: null,
    organizationId: DOCUMENT_ORG_ID,
    source: PRD_ENDPOINT,
    sourceId: PRD_DEFAULT.id,
    target: FEAT_CONTRAST_TEST,
    targetId: FEAT_CONTRAST_TEST.id,
  },
  {
    createdAt: USER_FIXTURE_DATE,
    id: "link-feat-plan-tint",
    linkType: LinkType.Produces,
    metadata: null,
    organizationId: DOCUMENT_ORG_ID,
    source: FEAT_DROP_TINT,
    sourceId: FEAT_DROP_TINT.id,
    target: PLAN_REMOVE_TINT,
    targetId: PLAN_REMOVE_TINT.id,
  },
];

type StoryPRDEditorHeaderProps = {
  prd: DocumentWithProject;
  onToggleMetadataPanel: () => void;
  onExport: () => void;
  onMove: () => void;
  showRestore?: boolean;
  onRestoreVersion?: () => void;
  onDelete: () => void;
};

/** `prd-editor-header.tsx`, copied verbatim except for `AppScreenShell`'s
 * `ORG_SLUG` in place of the blocked `useOrgSlug()` call — see the file doc
 * comment. Every other real behavior (the real `FavoriteButton`, the
 * overflow menu) is unchanged. */
function StoryPRDEditorHeader({
  prd,
  onToggleMetadataPanel,
  onExport,
  onMove,
  showRestore = false,
  onRestoreVersion,
  onDelete,
}: Readonly<StoryPRDEditorHeaderProps>) {
  const orgSlug = ORG_SLUG;

  const breadcrumbs: BreadcrumbEntry[] = prd.project?.teams?.[0]?.id
    ? [
        {
          label: prd.project.teams[0].name,
          href: `/${orgSlug}/teams/${prd.project.teams[0].id}/projects`,
        },
        {
          label: prd.project.name,
          href: `/${orgSlug}/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`,
        },
        { label: prd.title },
      ]
    : [{ label: "Library", href: `/${orgSlug}/prds` }, { label: prd.title }];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="More options" size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[160px]">
        <DropdownMenuItem onClick={() => onExport()}>
          <DownloadIcon className="h-4 w-4" />
          Export .md
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onMove()}>
          <FolderIcon className="h-4 w-4" />
          Move...
        </DropdownMenuItem>
        {showRestore ? (
          <DropdownMenuItem onClick={() => onRestoreVersion?.()}>
            <RotateCcwIcon className="h-4 w-4" />
            Restore Version
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onDelete()} variant="destructive">
          <TrashIcon className="h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Header
      afterBreadcrumbs={<FavoriteButton artifactId={prd.id} />}
      breadcrumbs={breadcrumbs}
      moreMenu={overflowMenu}
    >
      <Button
        aria-label="Toggle chat panel"
        onClick={() => onToggleMetadataPanel()}
        size="icon"
        title="Toggle chat panel"
        variant="ghost"
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}

type StoryPRDEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

/** `prd-editor.tsx`, copied with the substitution the file doc comment
 * documents: `ORG_SLUG` for the blocked `useOrgSlug()` call.
 * Everything else — `DocumentEditorScaffold`, `AssociatedArtifactsSection`,
 * the real scaffold-owned delete/move dialogs — is real and unmodified. */
function StoryPRDEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<StoryPRDEditorProps>) {
  const buildPermalinkUrl = useCommentPermalinkBuilder({
    documentType: document.type,
    documentSlug: document.slug,
    orgSlug: ORG_SLUG,
  });
  const prd = document;

  const redirectPath = prd.project?.teams?.[0]?.id
    ? `/${ORG_SLUG}/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
    : `/${ORG_SLUG}/prds`;

  return (
    <DocumentEditorScaffold
      buildPermalinkUrl={buildPermalinkUrl}
      currentVersion={currentVersion}
      deleteDialogTitle="PRD"
      detailsSections={() => <AssociatedArtifactsSection prdId={prd.id} />}
      document={prd}
      feedArtifactType={FeedArtifactType.Prd}
      onVersionChange={onVersionChange}
      redirectPath={redirectPath}
      renderHeader={(ctx: ScaffoldSlotContext) => (
        <StoryPRDEditorHeader
          onDelete={ctx.chrome.openDeleteDialog}
          onExport={ctx.actions.handleDownload}
          onMove={ctx.chrome.openMoveDialog}
          onRestoreVersion={ctx.contentController.restoreVersion}
          onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
          prd={prd}
          showRestore={ctx.session.isViewingHistorical}
        />
      )}
    />
  );
}

const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

type PRDDetailScreenProps = {
  /** Org-relative path the sidebar should mark as current. There is no
   * dedicated PRDs nav destination (PRDs are reached via Documents or a
   * Project's PRDs tab), so this defaults to Documents. */
  activePath?: string;
  /** The PRD fixture this story's fixture routes serve. Fixed per story, not
   * a control — see `argTypes.document` below. */
  document: DocumentDetail;
  /** The version `VersionedDocumentEditorContainer` opens on. Omit for the
   * latest version. Set below `document.latestVersion` to open on a
   * historical version — see the `HistoricalVersion` story below. */
  version?: number;
};

// `hideHeader`: this surface's own content renders the real production
// `Header` (via `StoryPRDEditorHeader`) inside the scaffold below — see
// `document-detail.stories.tsx`'s identical note on why the shell's own
// breadcrumb bar would be redundant, and why `SidebarProvider` is still
// load-bearing (the real `Header` renders `SidebarTrigger`).
const PRDDetailScreen = ({
  activePath = "/documents",
  document,
  version,
}: PRDDetailScreenProps) => (
  <AppScreenShell activePath={activePath} hideHeader>
    <VersionedDocumentEditorContainer
      editor={StoryPRDEditor}
      slug={document.slug}
      version={version}
    />
  </AppScreenShell>
);

/**
 * The fixture routes a PRD's mount needs — see the file doc comment for why
 * each entry is here.
 */
function appCoreParamsFor(
  document: DocumentDetail,
  options: {
    versionsByNumber?: Record<number, DocumentDetail>;
    associatedLinks?: ArtifactLinkWithEndpoints[];
  } = {}
) {
  const {
    versionsByNumber = { [document.latestVersion]: document },
    associatedLinks = ASSOCIATED_LINKS,
  } = options;

  return {
    apiRoutes: [
      {
        method: "GET",
        path: `/documents/by-slug/${document.slug}`,
        respond: ({ searchParams }: FixtureRequestContext) => {
          const requestedVersion =
            Number(searchParams.get("version")) || document.latestVersion;
          return versionsByNumber[requestedVersion] ?? document;
        },
      },
      {
        method: "POST",
        path: `/documents/${document.id}/versions`,
        respond: ({ body }: FixtureRequestContext) => {
          const input = (body ?? {}) as { content?: string };
          const nextVersion = document.latestVersion + 1;
          return {
            ...document,
            latestVersion: nextVersion,
            latestVersionContent:
              input.content ?? document.latestVersionContent,
            version: {
              ...document.version,
              content: input.content ?? document.version.content,
              id: `${document.id}-v${nextVersion}`,
              version: nextVersion,
            },
          };
        },
      },
      // Required, not just convenient — see the file doc comment: inline
      // Associated Artifact edits and "Detach" both invalidate this query,
      // and a `queryData`-only seed does not survive that refetch.
      {
        method: "GET",
        path: "/artifact-links/resolved",
        respond: () => associatedLinks,
      },
      {
        method: "DELETE",
        path: "/artifact-links/*",
        respond: () => ({ deleted: true }),
      },
      // Survives the FavoriteButton's own toggle-mutation invalidation — see
      // the file doc comment's favorites paragraph.
      {
        method: "GET",
        path: "/artifacts/favorites",
        respond: () => [],
      },
    ],
    queryData: [
      // Forces the scaffold's documented "user/org context not ready"
      // room-less path — see `document-detail.stories.tsx`'s identical note.
      [userKeys.currentUser(), null],
      [artifactFavoriteKeys.list(), []],
      [
        attachmentKeys.listByPurpose(
          document.id,
          AttachmentPurposeSelector.Context
        ),
        [],
      ],
      [
        attachmentKeys.listByPurpose(
          document.id,
          AttachmentPurposeSelector.Inline
        ),
        [],
      ],
      [userKeys.organizationUsers(), ORG_USERS_FIXTURE],
      // DocumentEditorScaffold -> useDocumentMetadata -> useTeamMembers reads
      // one of these per document.project.teams entry unconditionally (same
      // derivation as production's own `artifact.project?.teams?.map(...)`);
      // unseeded, the harness's fixture transport falls back to an
      // unmatched-GET default of `{}`, and transformMembers's `for (const
      // member of members)` throws on the non-array.
      ...(document.project?.teams ?? []).map(
        (team) => [teamKeys.members(team.id), []] as const
      ),
    ],
  };
}

/**
 * The org-level PRD editor at `/documents/[slug]`: a PRD's read/edit view and
 * its Associated Artifacts (the Features and Plans it produced) — the detail
 * screen every Feature/Plan traces back to.
 */
const meta = {
  title: "Surfaces v1.0/PRDs/PRD Detail",
  component: PRDDetailScreen,
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
        "The PRD fixture this story mounts. Not a live control — the object is too structured for the Controls panel; switch between the named stories below instead.",
      table: { disable: true },
    },
    version: {
      control: { type: "number", min: 1 },
      description:
        "The version VersionedDocumentEditorContainer opens on. Omit for latest; set below the fixture's latestVersion to open historical (renders the real Restore Version menu item).",
      table: { category: "State" },
    },
  },
  args: {
    activePath: "/documents",
    document: PRD_DEFAULT,
  },
  parameters: {
    layout: "fullscreen",
    // A fullscreen Surface, inlined into the Docs page's own prose-width
    // column, squeezes real components into far less width than they ever
    // get in the product — see `document-detail.stories.tsx`'s identical
    // note.
    docs: { story: { inline: false, iframeHeight: 900 } },
    appCore: appCoreParamsFor(PRD_DEFAULT),
  },
} satisfies Meta<typeof PRDDetailScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A PRD mid-review: real title, tags, and markdown body, a project/team
 * breadcrumb (`Platform > Inbox & Notifications`), and two real Associated
 * Artifacts (a Feature and, one level deeper, the Plan it produced). */
export const Default: Story = {};

/**
 * A PRD moments after generation: no project yet (renders the "Library"
 * breadcrumb branch instead of a team/project one — the other real branch of
 * `PRDEditorHeader`'s breadcrumb logic), and the real Associated Artifacts
 * empty state ("No associated features yet...") — nothing has been
 * decomposed yet.
 */
export const FreshlyGenerated: Story = {
  name: "Freshly generated (not yet reviewed)",
  args: { activePath: "/documents", document: PRD_FRESH },
  parameters: {
    appCore: appCoreParamsFor(PRD_FRESH, {
      associatedLinks: [],
    }),
  },
};

/**
 * No settled read yet: the real `VersionedDocumentEditorContainer`'s own
 * `isLoading` branch, the real `PageLoadingSpinner` — same technique as
 * `document-detail.stories.tsx`'s `Loading` story.
 */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: `/documents/by-slug/${PRD_DEFAULT.slug}`,
          respond: () => new Promise<never>(() => undefined),
        },
      ],
    },
  },
};

/**
 * Opens on v1 of a two-version PRD (`PRD_HISTORY_V1` — `latestVersion: 2`),
 * so `isViewingHistorical` is genuinely `true` and the real header overflow
 * menu's "Restore Version" item actually renders. The real `VersionSelector`
 * dropdown's v1/v2 entries both resolve to real, distinct content.
 */
export const HistoricalVersion: Story = {
  name: "Historical version (Restore Version)",
  args: { document: PRD_HISTORY_V1, version: 1 },
  parameters: {
    appCore: appCoreParamsFor(PRD_HISTORY_V1, {
      versionsByNumber: { 1: PRD_HISTORY_V1, 2: PRD_HISTORY_LATEST },
    }),
  },
};
