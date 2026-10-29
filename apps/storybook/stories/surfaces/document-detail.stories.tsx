import { AttachmentPurposeSelector } from "@repo/api/src/types/attachment";
import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  DocumentStatus,
  DocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { TagColor } from "@repo/api/src/types/tag";
import type { BasicUser } from "@repo/api/src/types/user";
import {
  DocumentEditorScaffold,
  type ScaffoldSlotContext,
} from "@repo/app/documents/components/document-editor-scaffold";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { artifactFavoriteKeys } from "@repo/app/documents/hooks/artifact-favorite-keys";
import { attachmentKeys } from "@repo/app/documents/hooks/use-attachments";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
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
  CopyIcon,
  DownloadIcon,
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
 * The org-level Document (DOC) editor (ISS-4382): `/documents/[slug]` for a
 * project-less evergreen document, the detail page every row on
 * `Surfaces/Documents/Listing` links to.
 *
 * WHY `DocumentEditor` — the innermost link of the real container chain
 * `DocumentEditorContainer` → `VersionedDocumentEditorContainer` →
 * `DocumentEditor` — is not mounted directly, and why this needed more than
 * mocking `useDocumentBySlug`'s query key (Approach A, as the task brief
 * describes it): `DocumentEditor` itself
 * (`apps/app/app/(authenticated)/[orgSlug]/documents/[slug]/document-editor.tsx`)
 * calls `useOrgSlug()` at its own top level, and so does
 * `DocumentEditorHeader`. `useOrgSlug()` (`apps/app/hooks/use-org-slug.ts`)
 * calls Clerk's own `useAuth()` / `useOrganization()` — `@repo/auth/client` is
 * a bare re-export of `@clerk/nextjs` — and Clerk's hooks assert a
 * `<ClerkProvider>` ancestor (`useAssertWrappedByClerkProvider`, read directly
 * out of `@clerk/shared`'s installed source before writing this file) and
 * throw without one. No `<ClerkProvider>` exists anywhere in this Storybook —
 * confirmed by grepping `apps/storybook/.storybook/` and
 * `packages/app/shared/storybook/` for one — by design: FEA-1510's whole
 * point is that `packages/app` proves it runs without Clerk. `DocumentEditor`
 * and `DocumentEditorHeader` are `apps/app`-ROUTE files, not part of that
 * portable layer, and neither takes `orgSlug` as a prop.
 *
 * `VersionedDocumentEditorContainer` itself — one link further out
 * (`apps/app/app/(authenticated)/[orgSlug]/components/
 * versioned-document-editor-container.tsx`) — has NO such wall: reading its
 * source shows it calls only `useDocumentBySlug` (a plain `@repo/app` query
 * hook) and Next's own `notFound()`, neither Clerk-coupled, so THIS story
 * mounts it for real rather than substituting a hand-rolled stand-in for it
 * too. Only the innermost `editor` slot — `DocumentEditor` /
 * `DocumentEditorHeader` — needs a substitute, exactly where the Clerk wall
 * actually is.
 *
 * What stays REAL, unmodified, from `packages/app`: `DocumentEditorScaffold`
 * — the actual collaborative editor shell, version selector, save/restore
 * toolbar, metadata bar, attachments row, related-sessions and comments
 * sections, delete/move dialogs — and every hook it owns
 * (`useEditorSession`, `useDocumentContent`, `useDocumentMetadata`,
 * `useDocumentActions`, `useEditorChrome`, `useInlineEditMode`). It never
 * calls `useOrgSlug()` itself; the two apps/app wrappers around it do, to
 * build a `buildPermalinkUrl` function and two breadcrumb hrefs. And, now,
 * `VersionedDocumentEditorContainer` too — real, unmodified, doing the exact
 * job it does in production: resolving `slug`/`version` into a `document` via
 * `useDocumentBySlug`, rendering the loading spinner while that read is in
 * flight, and handing the settled document plus a real `onVersionChange` down
 * to whichever `editor` it is given.
 *
 * `StoryDocumentEditor` / `StoryDocumentEditorHeader` below are
 * `document-editor.tsx` / `document-editor-header.tsx` copied verbatim with
 * that ONE call replaced by `AppScreenShell`'s own exported `ORG_SLUG` — and
 * nothing else changed. `DocumentDetailScreen` passes `StoryDocumentEditor` as
 * `VersionedDocumentEditorContainer`'s `editor` prop, the same shape
 * `DocumentEditorContainer` passes the real `DocumentEditor` in production.
 *
 * NO LIVE COLLABORATION: `useCurrentUser()` is seeded to resolve `null`
 * (`userKeys.currentUser()` in `queryData` below), which forces
 * `resolveActiveRoomId`'s documented "user/org context not ready" branch —
 * the SAME room-less state the real app renders in the window before `/me`
 * resolves (`document-editor-scaffold-helpers.ts`'s own doc comment calls
 * this "already supported"). With no active room, `RichTextEditorHost` takes
 * its plain (non-Liveblocks) branch, `DocumentFeedRail` and the comment
 * surfaces never mount, and the editor reads content straight from
 * `document.version.content` — real content, real editing, no attempted
 * network connection to a collaboration backend this Storybook cannot reach.
 *
 * Also seeded: `artifactFavoriteKeys.list()` and both
 * `attachmentKeys.listByPurpose` reads, to `[]`. Both are real `useQuery` /
 * `useQueries` calls this scaffold's real children make
 * (`FavoriteButton`, `AttachmentsRow`); left unseeded, this harness's fixture
 * transport defaults an unmatched GET to `{}` rather than `[]` (see
 * `fixture-fetch.ts`'s own comment on `LIST_READ_PATH_SUFFIXES`, which does
 * not cover either path), and both consumers call array methods on the
 * result — confirmed by reading `useIsFavoriteArtifact` and
 * `selectListedAttachments` before writing this, not guessed.
 *
 * A real `POST /documents/:id/versions` fixture route is also registered so
 * actually typing into the editor and clicking Save resolves to a
 * well-formed response — the default `{}` fallback would otherwise make
 * `useDocumentContent`'s `onSuccess` read `updatedArtifact.version.content`
 * off nothing. The story's own `document.latestVersion` does not advance
 * after a save (that self-heals via query cache invalidation in the real
 * app, which this static fixture does not replicate) — a known, harmless
 * limitation, not a bug in the composition.
 *
 * A real `GET /documents/by-slug/:slug` fixture route is registered too, now
 * that the mount is the real `VersionedDocumentEditorContainer` running its
 * own `useDocumentBySlug` query rather than a document handed in as a prop:
 * `appCoreParamsFor` answers with whichever fixture version the request's
 * `?version=` actually asked for (one entry for every story except
 * `HistoricalVersion` below, which registers both of its fixture's versions),
 * so the real `VersionSelector` dropdown resolves to real content instead of
 * the harness's `{}` fallback. `Loading` overrides this same route with one
 * that never resolves (`new Promise<never>(() => undefined)`, the technique
 * `invite-team-dialog.stories.tsx` / `token-trend-chart.stories.tsx` already
 * use), so what renders there is `VersionedDocumentEditorContainer`'s own
 * `isLoading` branch — the real `PageLoadingSpinner` — not a hand-rolled one.
 *
 * Verification note: like the Listing surface, this file was checked by
 * reading every component and hook it touches (imports, prop contracts,
 * query keys, feature-flag gates), not by rendering it in a live browser —
 * no interactive Storybook session was available while writing it.
 */

const DOCUMENT_ORG_ID = "org_closedloop";

const CREATED_BY: BasicUser = {
  id: "user-ottilie",
  firstName: "Ottilie",
  lastName: "Eye",
  email: "ottilie@closedloop.ai",
  avatarUrl: null,
};

const DOCUMENT_FIXTURE_DATE = new Date("2026-09-10T16:00:00.000Z");

function buildDocumentDetail({
  id,
  slug,
  title,
  status,
  content,
  latestVersion = 1,
  versionNumber = latestVersion,
  latestContent = content,
}: {
  id: string;
  slug: string;
  title: string;
  status: DocumentStatus;
  /** Content of the version this object's own `version` field represents. */
  content: string;
  /** The document's real latest version number. Defaults to 1 (single-version). */
  latestVersion?: number;
  /** Which version `version.content` is. Defaults to `latestVersion`. */
  versionNumber?: number;
  /**
   * Content of the LATEST version, per `DocumentDetail.latestVersionContent`'s
   * own contract ("saved content for the current latest version, even when
   * `version` is a historical selection"). Defaults to `content`, correct
   * whenever `versionNumber === latestVersion`.
   */
  latestContent?: string;
}): DocumentDetail {
  return {
    id,
    organizationId: DOCUMENT_ORG_ID,
    projectId: null,
    type: DocumentType.Doc,
    title,
    slug,
    fileName: null,
    status,
    priority: null,
    latestVersion,
    createdById: CREATED_BY.id,
    createdBy: CREATED_BY,
    assigneeId: CREATED_BY.id,
    assignee: CREATED_BY,
    approverId: null,
    approver: null,
    repositorySnapshot: { repositories: [], source: SnapshotSource.None },
    templateForType: null,
    sortOrder: 1,
    createdAt: DOCUMENT_FIXTURE_DATE,
    updatedAt: DOCUMENT_FIXTURE_DATE,
    project: null,
    tags: [
      { color: TagColor.Blue, id: "tag-playbook", name: "Playbook" },
      { color: TagColor.Violet, id: "tag-handoff", name: "Handoff" },
    ],
    version: {
      content,
      createdAt: DOCUMENT_FIXTURE_DATE,
      createdById: CREATED_BY.id,
      documentId: id,
      id: `${id}-v${versionNumber}`,
      version: versionNumber,
    },
    latestVersionContent: latestContent,
  };
}

const AGENT_HANDOFF_MARKDOWN = `# Agent Session Handoff Checklist

Run through this before you hand an agent-authored branch to a human
reviewer. It is a Doc, not a Plan — nothing here blocks a merge, it is just
the checklist the team agreed on.

## Before requesting review

- Confirm the session's summary actually describes what changed, not just
  what was asked for.
- Re-read the diff once, end to end, even if CI is green.
- Check that any new component has a story covering its loading, error, and
  empty states — not just the happy path.

## Flag anything the agent could not verify itself

Agents are honest about what they could not check. Carry that forward: if a
state was reasoned about rather than rendered, say so in the PR description
instead of letting it read as verified.

## After merge

- Watch the first deploy.
- Close the loop: drop a note back in the originating session so the next
  person picking up related work has the context.
`;

const DOCUMENT_DETAIL = buildDocumentDetail({
  content: AGENT_HANDOFF_MARKDOWN,
  id: "doc-agent-handoff",
  slug: "agent-session-handoff-checklist",
  status: DocumentStatus.InReview,
  title: "Agent Session Handoff Checklist",
});

const DOCUMENT_DETAIL_BLANK = buildDocumentDetail({
  content: "",
  id: "doc-fresh-blank",
  slug: "untitled-document",
  status: DocumentStatus.Draft,
  title: "Untitled Document",
});

const DESIGN_REVIEW_PROCESS_ID = "doc-design-review-process";
const DESIGN_REVIEW_PROCESS_SLUG = "design-review-process";

const DESIGN_REVIEW_V1_MARKDOWN = `# Design Review Process

Run every UI change through this before requesting sign-off.

## Steps

1. Post the Figma link and a one-line summary in #design-review.
2. Tag the reviewer for the surface you touched.
3. Wait for a thumbs-up before merging.
`;

const DESIGN_REVIEW_V2_MARKDOWN = `# Design Review Process

Run every UI change through this before requesting sign-off.

## Steps

1. Post the Figma link and a one-line summary in #design-review.
2. Tag the reviewer for the surface you touched.
3. Run the contrast checker against both themes and note the result.
4. Wait for a thumbs-up before merging.
`;

/**
 * A two-version document (ISS-4382 §"Restore Version"): v2 added the
 * contrast-check step, v1 is the version before it. Both fixture objects
 * share `id`/`slug`/`latestVersion: 2` — only `version` and
 * `latestVersionContent` differ, matching `DocumentDetail`'s own contract for
 * "viewing a historical version of a document whose latest is newer". The
 * `HistoricalVersion` story below opens on `DOCUMENT_DETAIL_HISTORY_V1`, the
 * only fixture in this file where `isViewingHistorical` (and therefore the
 * real "Restore Version" menu item) is genuinely `true`.
 */
const DOCUMENT_DETAIL_HISTORY_LATEST = buildDocumentDetail({
  content: DESIGN_REVIEW_V2_MARKDOWN,
  id: DESIGN_REVIEW_PROCESS_ID,
  latestVersion: 2,
  slug: DESIGN_REVIEW_PROCESS_SLUG,
  status: DocumentStatus.Approved,
  title: "Design Review Process",
  versionNumber: 2,
});

const DOCUMENT_DETAIL_HISTORY_V1 = buildDocumentDetail({
  content: DESIGN_REVIEW_V1_MARKDOWN,
  id: DESIGN_REVIEW_PROCESS_ID,
  latestContent: DESIGN_REVIEW_V2_MARKDOWN,
  latestVersion: 2,
  slug: DESIGN_REVIEW_PROCESS_SLUG,
  status: DocumentStatus.Approved,
  title: "Design Review Process",
  versionNumber: 1,
});

type StoryDocumentEditorHeaderProps = {
  document: DocumentDetail;
  isMetadataPanelOpen?: boolean;
  showRestore?: boolean;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onRestoreVersion?: () => void;
  onDelete: () => void;
  onToggleMetadataPanel: () => void;
};

/** `document-editor-header.tsx`, copied verbatim except for `AppScreenShell`'s
 * `ORG_SLUG` in place of the blocked `useOrgSlug()` call — see the file doc
 * comment. The real `Header`, the real `FavoriteButton`, and the same
 * overflow menu, unchanged. */
function StoryDocumentEditorHeader({
  document,
  isMetadataPanelOpen = false,
  onCopyMarkdown,
  onDelete,
  onExportMarkdown,
  onRestoreVersion,
  onToggleMetadataPanel,
  showRestore = false,
}: StoryDocumentEditorHeaderProps) {
  const breadcrumbs: BreadcrumbEntry[] = [
    { href: `/${ORG_SLUG}/documents`, label: "Documents" },
    { label: document.title },
  ];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="More options" size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px]">
        <DropdownMenuItem onClick={() => onExportMarkdown()}>
          <DownloadIcon className="h-4 w-4" />
          Export Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onCopyMarkdown()}>
          <CopyIcon className="h-4 w-4" />
          Copy Markdown
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
          Delete Document
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Header
      afterBreadcrumbs={<FavoriteButton artifactId={document.id} />}
      breadcrumbs={breadcrumbs}
      moreMenu={overflowMenu}
    >
      <Button
        aria-expanded={isMetadataPanelOpen}
        aria-label="Toggle side panel"
        onClick={() => onToggleMetadataPanel()}
        size="icon"
        title="Toggle side panel"
        variant="ghost"
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}

type StoryDocumentEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

/** `document-editor.tsx`, copied verbatim except for `AppScreenShell`'s
 * `ORG_SLUG` in place of the blocked `useOrgSlug()` call — see the file doc
 * comment. `DocumentEditorScaffold` underneath is the real, unmodified
 * `packages/app` component. */
function StoryDocumentEditor({
  currentVersion,
  document,
  onVersionChange,
}: StoryDocumentEditorProps) {
  const buildPermalinkUrl = useCommentPermalinkBuilder({
    documentSlug: document.slug,
    documentType: document.type,
    orgSlug: ORG_SLUG,
  });

  return (
    <DocumentEditorScaffold
      buildPermalinkUrl={buildPermalinkUrl}
      currentVersion={currentVersion}
      deleteDialogTitle="Document"
      detailsSections={() => null}
      document={document}
      emptyContentPlaceholder="Start writing..."
      feedArtifactType={FeedArtifactType.Doc}
      hideMoveAction
      hideRepositoriesInMetadataBar
      onVersionChange={onVersionChange}
      redirectPath={`/${ORG_SLUG}/documents`}
      renderHeader={(ctx: ScaffoldSlotContext) => (
        <StoryDocumentEditorHeader
          document={document}
          isMetadataPanelOpen={ctx.chrome.showMetadataPanel}
          onCopyMarkdown={ctx.actions.handleCopy}
          onDelete={ctx.chrome.openDeleteDialog}
          onExportMarkdown={ctx.actions.handleDownload}
          onRestoreVersion={ctx.contentController.restoreVersion}
          onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
          showRestore={ctx.session.isViewingHistorical}
        />
      )}
      startInEditModeWhenEmpty
    />
  );
}

const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

type DocumentDetailScreenProps = {
  /** Org-relative path the sidebar should mark as current. */
  activePath?: string;
  /** The document fixture this story's fixture routes serve. Fixed per story,
   * not a control — see `argTypes.document` below. */
  document: DocumentDetail;
  /**
   * The version `VersionedDocumentEditorContainer` opens on. Omit for the
   * latest version (the real container's own default when a route carries no
   * `?version=`). Set below `document.latestVersion` to open on a historical
   * version — see the `HistoricalVersion` story below.
   */
  version?: number;
};

// `hideHeader`: this surface's own content renders the real production
// `Header` (via `StoryDocumentEditorHeader`) inside the scaffold below, so
// the shell's generic breadcrumb bar would sit redundantly above it. The
// `SidebarProvider` this shell still supplies is load-bearing: the real
// `Header` renders `SidebarTrigger`, which throws without one.
const DocumentDetailScreen = ({
  activePath = "/documents",
  document,
  version,
}: DocumentDetailScreenProps) => (
  <AppScreenShell activePath={activePath} hideHeader>
    {/* Real component, unmodified: `VersionedDocumentEditorContainer` owns
        the `useDocumentBySlug` read, the loading spinner, and version-change
        wiring — see the file doc comment for why it, unlike `DocumentEditor`
        one layer in, has no Clerk wall of its own. */}
    <VersionedDocumentEditorContainer
      editor={StoryDocumentEditor}
      slug={document.slug}
      version={version}
    />
  </AppScreenShell>
);

/**
 * The fixture routes this document's mount needs — see the file doc comment
 * for why each entry is here. Built per-fixture so the attachment keys (which
 * embed the document id) always match the document the story actually
 * mounts.
 *
 * `versionsByNumber` answers the real `GET /documents/by-slug/:slug` read for
 * whichever version the request asked for, defaulting to a one-entry map (the
 * fixture's own version) for every story except `HistoricalVersion`, which
 * passes both of its fixture's versions so the real `VersionSelector`
 * dropdown resolves either entry to real content.
 */
function appCoreParamsFor(
  document: DocumentDetail,
  versionsByNumber: Record<number, DocumentDetail> = {
    [document.latestVersion]: document,
  }
) {
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
    ],
    queryData: [
      // Forces the scaffold's documented "user/org context not ready"
      // room-less path rather than a live Liveblocks connection — see the
      // file doc comment.
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
    ],
  };
}

/**
 * The org-level Document editor at `/documents/[slug]`: a single evergreen
 * document's read/edit view, reached from a row on the Listing surface above.
 */
const meta = {
  title: "Surfaces v1.0/Documents/Document Detail",
  component: DocumentDetailScreen,
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
        "The document fixture this story mounts. Not a live control — the object is too structured for the Controls panel; switch between the named stories below instead.",
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
    document: DOCUMENT_DETAIL,
  },
  parameters: {
    layout: "fullscreen",
    // A fullscreen Surface, inlined into the Docs page's own prose-width
    // column, squeezes real components into far less width than they ever
    // get in the product. `inline: false` renders the Docs preview in its
    // own full-width iframe instead, the documented Storybook fix for
    // exactly this mismatch.
    docs: { story: { inline: false, iframeHeight: 900 } },
    appCore: appCoreParamsFor(DOCUMENT_DETAIL),
  },
} satisfies Meta<typeof DocumentDetailScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A populated document, read view: real title, real tags, real markdown
 * body rendered through the real editor, version selector showing only v1 —
 * this fixture is single-version. See `HistoricalVersion` below for a
 * document with real version history and the "Restore Version" action. */
export const Default: Story = {};

/**
 * A brand-new document with no content yet. `DocumentEditorScaffold` opens
 * this straight into edit mode with the cursor placed (`startInEditModeWhenEmpty`,
 * ISS-4382) instead of a near-blank read-only screen — the real first-write
 * experience after clicking "New Document" on the Listing surface.
 */
export const FreshBlankDocument: Story = {
  name: "Fresh blank document",
  args: { document: DOCUMENT_DETAIL_BLANK },
  parameters: { appCore: appCoreParamsFor(DOCUMENT_DETAIL_BLANK) },
};

/**
 * No settled read yet: the real `VersionedDocumentEditorContainer`'s own
 * `isLoading` branch, the real `PageLoadingSpinner` — not a hand-rolled one.
 * The GET fixture route below never resolves, the same technique
 * `invite-team-dialog.stories.tsx` / `token-trend-chart.stories.tsx` use for
 * their own in-flight states.
 */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: `/documents/by-slug/${DOCUMENT_DETAIL.slug}`,
          respond: () => new Promise<never>(() => undefined),
        },
      ],
    },
  },
};

/**
 * Opens on v1 of a two-version document (`DOCUMENT_DETAIL_HISTORY_V1` —
 * `latestVersion: 2`), so `isViewingHistorical` is genuinely `true` and the
 * real header overflow menu's "Restore Version" item actually renders —
 * unlike every other story in this file, whose single-version fixtures can
 * never reach it. The real `VersionSelector` dropdown's v1/v2 entries both
 * resolve to real, distinct content (the fixture route answers either
 * version), so switching between them is genuinely live too.
 */
export const HistoricalVersion: Story = {
  name: "Historical version (Restore Version)",
  args: { document: DOCUMENT_DETAIL_HISTORY_V1, version: 1 },
  parameters: {
    appCore: appCoreParamsFor(DOCUMENT_DETAIL_HISTORY_V1, {
      1: DOCUMENT_DETAIL_HISTORY_V1,
      2: DOCUMENT_DETAIL_HISTORY_LATEST,
    }),
  },
};
